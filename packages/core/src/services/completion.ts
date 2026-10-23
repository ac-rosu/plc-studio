// Completion and signature help (spec, "Editor features (v1)"). While typing, the statement is
// often incomplete, so member chains (#Recipe.Header.) are resolved from the text, not from the
// analysis.
import type { Parameter } from '@plcstudio/profiles';
import type { BlockSymbol, Project } from '../model/project.ts';
import { membersOf, typeName, type DataType, type MemberInfo } from '../model/types.ts';
import { blockAt, memberComments, pickText, scopeMembers } from './info.ts';

export type CompletionKind =
  | 'variable'
  | 'field'
  | 'function'
  | 'module'
  | 'class'
  | 'struct'
  | 'keyword'
  | 'constant'
  | 'snippet'
  | 'property'
  | 'enumMember';

export interface CompletionEntry {
  readonly label: string;
  readonly kind: CompletionKind;
  readonly detail?: string;
  readonly documentation?: string;
  /** Text to insert; a snippet when `snippet` is true ($1, ${1:name}). */
  readonly insertText?: string;
  readonly snippet?: boolean;
  readonly sortText?: string;
  /** Characters before the cursor this item replaces. */
  readonly replaceLength?: number;
}

const KEYWORDS = [
  'IF',
  'THEN',
  'ELSIF',
  'ELSE',
  'END_IF',
  'CASE',
  'OF',
  'END_CASE',
  'FOR',
  'TO',
  'BY',
  'DO',
  'END_FOR',
  'WHILE',
  'END_WHILE',
  'REPEAT',
  'UNTIL',
  'END_REPEAT',
  'EXIT',
  'CONTINUE',
  'RETURN',
  'GOTO',
  'REGION',
  'END_REGION',
  'AND',
  'OR',
  'XOR',
  'NOT',
  'MOD',
  'TRUE',
  'FALSE',
];

const SNIPPETS: { label: string; body: string; detail: string }[] = [
  { label: 'IF … END_IF', body: 'IF ${1:condition} THEN\n\t$0\nEND_IF;', detail: 'IF statement' },
  {
    label: 'IF … ELSE … END_IF',
    body: 'IF ${1:condition} THEN\n\t$2\nELSE\n\t$0\nEND_IF;',
    detail: 'IF statement with ELSE',
  },
  {
    label: 'CASE … END_CASE',
    body: 'CASE ${1:selector} OF\n\t${2:0}:\n\t\t$3\n\tELSE\n\t\t$0\nEND_CASE;',
    detail: 'CASE statement with ELSE',
  },
  {
    label: 'FOR … END_FOR',
    body: 'FOR ${1:#Index} := ${2:0} TO ${3:9} DO\n\t$0\nEND_FOR;',
    detail: 'FOR loop',
  },
  {
    label: 'WHILE … END_WHILE',
    body: 'WHILE ${1:condition} DO\n\t$0\nEND_WHILE;',
    detail: 'WHILE loop',
  },
  {
    label: 'REPEAT … END_REPEAT',
    body: 'REPEAT\n\t$0\nUNTIL ${1:condition}\nEND_REPEAT;',
    detail: 'REPEAT loop',
  },
  { label: 'REGION … END_REGION', body: 'REGION ${1:name}\n\t$0\nEND_REGION', detail: 'Region' },
];

const LITERALS: { label: string; body: string; detail: string }[] = [
  { label: 'T#', body: 'T#${1:1s}', detail: 'Time literal' },
  { label: 'LT#', body: 'LT#${1:1s}', detail: 'LTime literal (S7-1500)' },
  { label: '16#', body: '16#${1:FF}', detail: 'Hexadecimal literal' },
  { label: '2#', body: '2#${1:0101}', detail: 'Binary literal' },
  { label: 'INT#', body: 'INT#${1:0}', detail: 'Typed Int literal' },
  { label: 'DINT#', body: 'DINT#${1:0}', detail: 'Typed DInt literal' },
  { label: 'REAL#', body: 'REAL#${1:0.0}', detail: 'Typed Real literal' },
  { label: 'TOD#', body: 'TOD#${1:00:00:00}', detail: 'Time of day literal' },
  { label: 'D#', body: 'D#${1:2026-01-01}', detail: 'Date literal' },
  { label: 'DTL#', body: 'DTL#${1:2026-01-01-00:00:00}', detail: 'DTL literal' },
];

function memberKind(m: MemberInfo): CompletionKind {
  if (m.section === 'Constant') return 'constant';
  if (m.type.kind === 'fb' || (m.type.kind === 'system' && m.type.type.kind === 'fb'))
    return 'module';
  if (m.type.kind === 'struct' || m.type.kind === 'udt') return 'struct';
  return m.section ? 'variable' : 'field';
}

function memberEntry(
  project: Project,
  block: BlockSymbol | undefined,
  m: MemberInfo,
  language: string | undefined,
  prefix = '',
): CompletionEntry {
  const comment = block ? pickText(memberComments(project, block, m.node), language) : undefined;
  return {
    label: prefix + m.name,
    kind: memberKind(m),
    detail: `${typeName(m.type)}${m.section ? ` · ${m.section}` : ''}`,
    ...(comment ? { documentation: comment } : {}),
    insertText: /^[A-Za-z_][A-Za-z0-9_]*$/.test(m.name) ? m.name : `"${m.name}"`,
  };
}

/** Resolves a chain such as #Recipe.Header or "DB_Machine".Limits to a type. */
export function resolveChain(
  project: Project,
  block: BlockSymbol | undefined,
  chain: string,
): DataType | undefined {
  const parts = splitChain(chain);
  if (parts.length === 0) return undefined;
  const index = project.index;
  let type: DataType | undefined;
  const first = parts[0]!;
  let rest = parts.slice(1);
  if (first.startsWith('#')) {
    const name = unquote(first.slice(1));
    const m = block
      ? scopeMembers(project, block).find((x) => x.name.toLowerCase() === name.toLowerCase())
      : undefined;
    type = m?.type;
  } else if (first.startsWith('"')) {
    const name = unquote(first);
    const b = index.findBlock(name, block?.namespace);
    if (b?.kind === 'DB') type = index.dbType(b);
    else if (b?.kind === 'FB') type = index.fbType(b);
    else {
      const tag = index.findTag(name);
      if (tag) type = index.tagType(tag);
    }
  } else if (first === '_') {
    // _.Tag or _.Ns.Block
    for (let i = 1; i <= rest.length; i++) {
      const path = rest.slice(0, i).map(unquote);
      const name = path[path.length - 1]!;
      const b = index.findBlock(name, block?.namespace, path.slice(0, -1).join('.') || null);
      if (b) {
        type = b.kind === 'DB' ? index.dbType(b) : b.kind === 'FB' ? index.fbType(b) : undefined;
        rest = rest.slice(i);
        break;
      }
      if (i === 1) {
        const tag = index.findTag(name);
        if (tag) {
          type = index.tagType(tag);
          rest = rest.slice(1);
          break;
        }
      }
    }
  }
  for (const part of rest) {
    if (!type) return undefined;
    if (part === '[]') {
      type = type.kind === 'array' ? type.element : undefined;
      continue;
    }
    if (part === '^') {
      type = type.kind === 'ref' ? type.target : undefined;
      continue;
    }
    const name = unquote(part).toLowerCase();
    if (type.kind === 'system') {
      const p = type.type.parameters.find((x) => x.name.toLowerCase() === name);
      const m = type.type.members.find((x) => x.name.toLowerCase() === name);
      const t = p?.type ?? m?.type;
      const e = t ? project.profile.elementary(t) : undefined;
      type = e
        ? { kind: 'elementary', name: e.name, info: e }
        : t
          ? { kind: 'generic', name: t }
          : undefined;
      continue;
    }
    type = membersOf(type)?.find((m) => m.name.toLowerCase() === name)?.type;
  }
  return type;
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length > 1 ? s.slice(1, -1) : s;
}

/** "#a.b[3].c" → ['#a', 'b', '[]', 'c']; quoted names stay whole. */
function splitChain(chain: string): string[] {
  const out: string[] = [];
  let i = 0;
  let current = '';
  while (i < chain.length) {
    const c = chain[i]!;
    if (c === '"') {
      const end = chain.indexOf('"', i + 1);
      current += chain.slice(i, end < 0 ? chain.length : end + 1);
      i = end < 0 ? chain.length : end + 1;
      continue;
    }
    if (c === '.') {
      if (current) out.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === '[') {
      if (current) out.push(current);
      current = '';
      let depth = 1;
      i++;
      while (i < chain.length && depth > 0) {
        if (chain[i] === '[') depth++;
        if (chain[i] === ']') depth--;
        i++;
      }
      out.push('[]');
      continue;
    }
    if (c === '^') {
      if (current) out.push(current);
      current = '';
      out.push('^');
      i++;
      continue;
    }
    current += c;
    i++;
  }
  if (current) out.push(current);
  return out;
}

/** The text of the current line up to the cursor, with strings and comments considered. */
function lineBefore(text: string, offset: number): string {
  const start =
    Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1;
  return text.slice(start, offset);
}

function inStringOrComment(line: string): boolean {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (!inString && c === '/' && line[i + 1] === '/') return true;
    if (c === "'") inString = !inString;
  }
  return inString;
}

export interface CallContext {
  readonly callee: string;
  readonly argumentIndex: number;
  /** Text from the '(' to the cursor. */
  readonly argsText: string;
  readonly openOffset: number;
}

/** The innermost unclosed call around the cursor: `"FC_X"(A := 1, |`. */
export function callContext(text: string, offset: number): CallContext | undefined {
  let depth = 0;
  let commas = 0;
  let inString = false;
  const limit = Math.max(0, offset - 4000);
  for (let i = offset - 1; i >= limit; i--) {
    const c = text[i]!;
    if (c === "'") inString = !inString;
    if (inString) continue;
    if (c === ';') return undefined;
    if (c === ')' || c === ']') depth++;
    else if (c === '[') depth--;
    else if (c === '(') {
      if (depth === 0) {
        const before = text.slice(Math.max(0, i - 200), i);
        const m =
          /((?:_\.)?(?:#?"[^"]+"|#?[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))*)\s*$/.exec(
            before,
          );
        if (!m) return undefined;
        return {
          callee: m[1]!,
          argumentIndex: commas,
          argsText: text.slice(i + 1, offset),
          openOffset: i,
        };
      }
      depth--;
    } else if (c === ',' && depth === 0) commas++;
  }
  return undefined;
}

export interface CalleeSignature {
  readonly label: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly label: string;
    readonly direction: Parameter['direction'];
    readonly type: string;
    readonly documentation?: string;
  }[];
  readonly documentation?: string;
}

/** Parameters of what a call names: an FC, an instance (multi, single, system FB) or an instruction. */
export function calleeSignature(
  project: Project,
  block: BlockSymbol | undefined,
  callee: string,
  language?: string,
): CalleeSignature | undefined {
  const index = project.index;
  const fromMembers = (target: BlockSymbol, label: string): CalleeSignature => {
    const ps = index
      .interfaceMembers(target)
      .filter((m) => m.section === 'Input' || m.section === 'Output' || m.section === 'InOut')
      .map((m) => {
        const doc = pickText(memberComments(project, target, m.node), language);
        return {
          name: m.name,
          direction: (m.section === 'Input'
            ? 'in'
            : m.section === 'Output'
              ? 'out'
              : 'inout') as Parameter['direction'],
          type: typeName(m.type),
          label: `${m.name} ${m.section === 'Output' ? '=>' : ':='} ${typeName(m.type)}`,
          ...(doc ? { documentation: doc } : {}),
        };
      });
    return { label: `${label}(${ps.map((p) => p.label).join(', ')})`, parameters: ps };
  };
  const fromProfile = (
    name: string,
    params: readonly Parameter[],
    doc?: string,
  ): CalleeSignature => {
    const ps = params.map((p) => ({
      name: p.name,
      direction: p.direction,
      type: p.type,
      label: `${p.name} ${p.direction === 'out' ? '=>' : ':='} ${p.type}${p.optional ? '?' : ''}`,
    }));
    return {
      label: `${name}(${ps.map((p) => p.label).join(', ')})`,
      parameters: ps,
      ...(doc ? { documentation: doc } : {}),
    };
  };
  if (callee.startsWith('#')) {
    const type = resolveChain(project, block, callee);
    if (type?.kind === 'fb') {
      const target = index.block(type.block.id);
      if (target) return fromMembers(target, callee);
    }
    if (type?.kind === 'system' && type.type.kind === 'fb')
      return fromProfile(callee, type.type.parameters, type.type.description);
    // #Delay.TON in LAD
    const dot = callee.lastIndexOf('.');
    if (dot > 0) {
      const inst = resolveChain(project, block, callee.slice(0, dot));
      if (inst?.kind === 'system')
        return fromProfile(callee, inst.type.parameters, inst.type.description);
    }
    return undefined;
  }
  const name = unquote(callee.replace(/^_\./, '').split('.').pop() ?? '');
  const target =
    index.findBlock(unquote(callee.replace(/^_\./, '')), block?.namespace) ??
    index.findBlock(name, block?.namespace);
  if (target?.kind === 'FC') return fromMembers(target, callee);
  if (target?.kind === 'DB' && target.dbKind === 'instance') {
    const fb = index.resolveType(
      target.block.dbType,
      target.namespace,
      target.id,
      target.file.path,
    );
    if (fb.kind === 'fb') {
      const fbSymbol = index.block(fb.block.id);
      if (fbSymbol) return fromMembers(fbSymbol, callee);
    }
    if (fb.kind === 'system') return fromProfile(callee, fb.type.parameters, fb.type.description);
  }
  const instruction = project.profile.instruction(name);
  if (instruction)
    return fromProfile(instruction.name, instruction.parameters, instruction.description);
  const conversion = project.profile.conversion(name);
  if (conversion)
    return fromProfile(
      name.toUpperCase(),
      [{ name: 'IN', direction: 'in', type: conversion.from.name, optional: false }],
      `Converts ${conversion.from.name} into ${conversion.to.name}.`,
    );
  return undefined;
}

export function completionsAt(
  project: Project,
  file: string,
  offset: number,
  language?: string,
): CompletionEntry[] {
  const source = project.files.get(file)?.source;
  if (!source) return [];
  const text = source.text;
  const line = lineBefore(text, offset);
  if (inStringOrComment(line)) return [];
  const block = blockAt(project, file, offset);
  const index = project.index;

  // member access: #a.b.|  "DB".x.|  _.Ns.|
  const member =
    /((?:_|#?"[^"]*"|#?[A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\]|\^|\.(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*))*)\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(
      line,
    );
  if (member && !/^\d/.test(member[1]!)) {
    const chain = member[1]!;
    const typed = member[2]?.length ?? 0;
    if (chain === '_') {
      const namespaces = new Set(
        index.blocks.map((b) => b.namespace).filter((n): n is string => !!n),
      );
      return [
        ...[...namespaces].map((n) => ({
          label: n,
          kind: 'module' as const,
          detail: 'namespace',
          replaceLength: typed,
        })),
        ...index.blocks
          .filter((b) => !b.namespace)
          .map((b) => ({
            label: b.name,
            kind: (b.kind === 'DB' ? 'variable' : 'class') as CompletionKind,
            detail: b.kind,
            replaceLength: typed,
          })),
        ...index.tags.map((t) => ({
          label: t.name,
          kind: (t.kind === 'tag' ? 'variable' : 'constant') as CompletionKind,
          detail: t.entry.dataType,
          replaceLength: typed,
        })),
      ];
    }
    const nsMatch = /^_\.(.+)$/.exec(chain);
    if (nsMatch) {
      const ns = nsMatch[1]!;
      const inNs = index.blocks.filter((b) => b.namespace?.toLowerCase() === ns.toLowerCase());
      if (inNs.length > 0)
        return inNs.map((b) => ({
          label: b.name,
          kind: (b.kind === 'DB' ? 'variable' : 'class') as CompletionKind,
          detail: `${b.kind}${b.published === false ? ' · not published' : ''}`,
          replaceLength: typed,
        }));
    }
    const type = resolveChain(project, block, chain);
    if (!type) return [];
    if (type.kind === 'system') {
      return [
        ...type.type.parameters.map((p) => ({
          label: p.name,
          kind: 'field' as const,
          detail: `${p.type} · ${p.direction}`,
          replaceLength: typed,
        })),
        ...type.type.members.map((m) => ({
          label: m.name,
          kind: 'field' as const,
          detail: m.type,
          replaceLength: typed,
        })),
      ];
    }
    if (type.kind === 'elementary' && ['bit', 'int'].includes(type.info.class)) {
      return ['%X0', '%B0', '%W0', '%D0'].map((s) => ({
        label: s,
        kind: 'property' as const,
        detail: 'slice access',
        replaceLength: typed,
      }));
    }
    const owner = type.kind === 'udt' || type.kind === 'fb' ? index.block(type.block.id) : block;
    return (membersOf(type) ?? []).map((m) => ({
      ...memberEntry(project, owner, m, language),
      replaceLength: typed,
    }));
  }

  // locals: #na|
  const local = /#(?:"([^"]*)|([A-Za-z0-9_]*))$/.exec(line);
  if (local && block) {
    const typed = local[1] !== undefined ? local[1].length + 1 : local[2]!.length;
    const entries: CompletionEntry[] = scopeMembers(project, block).map((m) => ({
      ...memberEntry(project, block, m, language),
      replaceLength: typed,
    }));
    if (block.kind === 'FC')
      entries.push({
        label: block.name,
        kind: 'variable',
        detail: 'return value',
        replaceLength: typed,
      });
    return entries;
  }

  // globals: "na|
  // an odd number of quotes on the line: a global name is being typed
  const global = (line.match(/"/g)?.length ?? 0) % 2 === 1 ? /"([^"]*)$/.exec(line) : null;
  if (global) {
    const typed = global[1]!.length;
    const entries: CompletionEntry[] = [];
    for (const b of index.blocks) {
      if (b.kind === 'OB') continue;
      if (b.namespace && b.namespace !== block?.namespace) continue;
      entries.push({
        label: b.name,
        kind: b.kind === 'DB' ? 'variable' : b.kind === 'UDT' ? 'struct' : 'function',
        detail: b.kind === 'DB' ? `${b.dbKind ?? 'global'} DB` : b.kind,
        insertText: `${b.name}"`,
        replaceLength: typed,
      });
    }
    for (const t of index.tags) {
      const comment = pickText(
        new Map([...t.entry.comments].map(([c, v]) => [c, v.text])),
        language,
      );
      entries.push({
        label: t.name,
        kind: t.kind === 'tag' ? 'variable' : 'constant',
        detail: `${t.entry.dataType}${t.entry.address ? ' ' + t.entry.address : ''}`,
        ...(comment ? { documentation: comment } : {}),
        insertText: `${t.name}"`,
        replaceLength: typed,
      });
    }
    return entries;
  }

  // parameter names inside a call: "FC_X"(In|
  const call = callContext(text, offset);
  if (call) {
    const lastArg = call.argsText.slice(call.argsText.lastIndexOf(',') + 1);
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*$|^\s*$/.test(lastArg)) {
      const signature = calleeSignature(project, block, call.callee, language);
      if (signature) {
        const typed = /[A-Za-z0-9_]*$/.exec(lastArg)![0].length;
        const given = new Set(
          [...call.argsText.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=>)/g)].map((m) =>
            m[1]!.toLowerCase(),
          ),
        );
        return signature.parameters
          .filter((p) => !given.has(p.name.toLowerCase()))
          .map((p, i) => ({
            label: p.name,
            kind: 'property' as const,
            detail: p.label,
            ...(p.documentation ? { documentation: p.documentation } : {}),
            insertText: `${p.name} ${p.direction === 'out' ? '=>' : ':='} $0`,
            snippet: true,
            sortText: String(i).padStart(3, '0'),
            replaceLength: typed,
          }));
      }
    }
  }

  // anything else: keywords, statements, instructions, typed literals
  const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(line)?.[0] ?? '';
  const out: CompletionEntry[] = [];
  for (const k of KEYWORDS) out.push({ label: k, kind: 'keyword', replaceLength: word.length });
  for (const s of SNIPPETS)
    out.push({
      label: s.label,
      kind: 'snippet',
      detail: s.detail,
      insertText: s.body,
      snippet: true,
      replaceLength: word.length,
      sortText: 'zz' + s.label,
    });
  for (const l of LITERALS)
    out.push({
      label: l.label,
      kind: 'snippet',
      detail: l.detail,
      insertText: l.body,
      snippet: true,
      replaceLength: word.length,
      sortText: 'zz' + l.label,
    });
  for (const i of project.profile.allInstructions()) {
    if (i.kind === 'fb') continue;
    const formal =
      i.nonFormal && i.parameters.length === 1
        ? `${i.name}(\${1})`
        : `${i.name}(${i.parameters.map((p, n) => `${p.name} ${p.direction === 'out' ? '=>' : ':='} \${${n + 1}}`).join(', ')})`;
    out.push({
      label: i.name,
      kind: 'function',
      detail: 'instruction',
      documentation: i.description,
      insertText: formal,
      snippet: true,
      replaceLength: word.length,
    });
  }
  if (block) {
    for (const m of scopeMembers(project, block))
      out.push({
        ...memberEntry(project, block, m, language, '#'),
        insertText: `#${m.name}`,
        replaceLength: word.length,
        sortText: '0' + m.name,
      });
  }
  return out;
}

export interface SignatureInfo {
  readonly signature: CalleeSignature;
  readonly activeParameter: number;
}

export function signatureHelpAt(
  project: Project,
  file: string,
  offset: number,
  language?: string,
): SignatureInfo | undefined {
  const source = project.files.get(file)?.source;
  if (!source) return undefined;
  const call = callContext(source.text, offset);
  if (!call) return undefined;
  const block = blockAt(project, file, offset);
  const signature = calleeSignature(project, block, call.callee, language);
  if (!signature) return undefined;
  // formal parameter being typed: match its name, else count commas
  const lastArg = call.argsText.slice(call.argsText.lastIndexOf(',') + 1);
  const named = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=>)/.exec(lastArg)?.[1];
  const byName = named
    ? signature.parameters.findIndex((p) => p.name.toLowerCase() === named.toLowerCase())
    : -1;
  return {
    signature,
    activeParameter:
      byName >= 0
        ? byName
        : Math.min(call.argumentIndex, Math.max(0, signature.parameters.length - 1)),
  };
}
