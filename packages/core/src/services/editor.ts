// Outline, folding, semantic tokens, inlay hints, hover text, code lenses, call hierarchy and
// quick fixes (spec, "Editor features (v1)"). Results use offsets; the language server converts.
import type { Block, BlockFile, Member, Network, SectionKind, Statement } from '../syntax/ast.ts';
import type { BlockSymbol, Project } from '../model/project.ts';
import { typeName } from '../model/types.ts';
import { analyzeProject } from '../check/analysis.ts';
import type { CallSite, Reference } from '../check/binder.ts';
import type { TextEdit } from '../writer/text-edit.ts';
import type { Range } from '../text/source-text.ts';
import { blockAt, describeSymbol, memberById, pickText } from './info.ts';
import { calleeSignature } from './completion.ts';
import { referenceAt } from './navigation.ts';

// --- Outline ---------------------------------------------------------------------------------

export type OutlineKind =
  | 'module'
  | 'class'
  | 'function'
  | 'struct'
  | 'object'
  | 'namespace'
  | 'field'
  | 'variable'
  | 'constant'
  | 'event'
  | 'property';

export interface OutlineItem {
  readonly name: string;
  readonly detail: string;
  readonly kind: OutlineKind;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children: OutlineItem[];
}

const BLOCK_KIND: Record<Block['kind'], OutlineKind> = {
  OB: 'module',
  FB: 'class',
  FC: 'function',
  DB: 'object',
  UDT: 'struct',
};

function memberItems(members: readonly Member[], kind: OutlineKind): OutlineItem[] {
  return members.map((m) => ({
    name: m.name.text,
    detail: m.type.kind === 'named' ? m.type.path.map((p) => p.text).join('.') : m.type.kind,
    kind,
    range: m.range,
    selectionRange: m.name.range,
    children: m.type.kind === 'struct' ? memberItems(m.type.members, 'field') : [],
  }));
}

function regionItems(statements: readonly Statement[]): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const s of statements) {
    if (s.kind === 'region') {
      out.push({
        name: s.title || 'REGION',
        detail: 'region',
        kind: 'namespace',
        range: s.range,
        selectionRange: s.titleRange.end > s.titleRange.start ? s.titleRange : s.range,
        children: regionItems(s.body),
      });
    }
  }
  return out;
}

export function outline(
  file: BlockFile,
  titles?: (network: Network) => string | undefined,
): OutlineItem[] {
  return file.blocks.map((block) => {
    const children: OutlineItem[] = [];
    for (const section of block.sections) {
      const kind: OutlineKind =
        section.kind === 'Constant'
          ? 'constant'
          : section.kind === 'Static' || section.kind === 'Temp'
            ? 'variable'
            : 'field';
      children.push({
        name: section.keyword,
        detail: section.kind,
        kind: 'namespace',
        range: section.range,
        selectionRange: section.headerRange,
        children: memberItems(section.members, kind),
      });
    }
    if (block.struct) children.push(...memberItems(block.struct.members, 'field'));
    for (const n of block.networks) {
      const title = titles?.(n);
      const regions = n.statements ? regionItems(n.statements) : [];
      if (block.networks.length === 1 && n.language === 'SCL') {
        children.push(...regions);
        continue;
      }
      children.push({
        name: `Network ${n.index}${title ? ': ' + title : ''}`,
        detail: n.language,
        kind: 'event',
        range: n.range,
        selectionRange: n.keywordRange,
        children: regions,
      });
    }
    return {
      name: block.namespace ? `${block.namespace}.${block.name.text}` : block.name.text,
      detail: block.kind,
      kind: BLOCK_KIND[block.kind],
      range: block.range,
      selectionRange: block.name.range,
      children,
    };
  });
}

export interface WorkspaceSymbolItem {
  readonly name: string;
  readonly kind: OutlineKind;
  readonly container: string | undefined;
  readonly file: string;
  readonly range: Range;
}

export function workspaceSymbols(project: Project, query: string): WorkspaceSymbolItem[] {
  const q = query.toLowerCase();
  const match = (name: string) => q === '' || name.toLowerCase().includes(q);
  const out: WorkspaceSymbolItem[] = [];
  for (const b of project.index.blocks) {
    const name = b.namespace ? `${b.namespace}.${b.name}` : b.name;
    if (match(name))
      out.push({
        name,
        kind: BLOCK_KIND[b.kind],
        container: b.unit?.name,
        file: b.file.path,
        range: b.block.name.range,
      });
  }
  for (const t of project.index.tags) {
    if (match(t.name))
      out.push({
        name: t.name,
        kind: t.kind === 'tag' ? 'variable' : 'constant',
        container: t.table.name,
        file: t.file.path,
        range: t.entry.nameRange,
      });
  }
  return out;
}

// --- Folding ---------------------------------------------------------------------------------

export interface FoldingItem {
  readonly start: number;
  readonly end: number;
  readonly kind: 'region' | 'comment' | undefined;
}

export function foldingRanges(file: BlockFile): FoldingItem[] {
  const out: FoldingItem[] = [];
  const add = (r: Range, kind?: 'region' | 'comment') =>
    out.push({ start: r.start, end: r.end, kind });
  const walk = (list: readonly Statement[]) => {
    for (const s of list) {
      switch (s.kind) {
        case 'region':
          add(s.range, 'region');
          walk(s.body);
          break;
        case 'if':
          s.branches.forEach((b) => walk(b.body));
          if (s.elseBody) walk(s.elseBody);
          add(s.range);
          break;
        case 'case':
          s.clauses.forEach((c) => walk(c.body));
          if (s.elseBody) walk(s.elseBody);
          add(s.range);
          break;
        case 'for':
        case 'while':
        case 'repeat':
          walk(s.body);
          add(s.range);
          break;
        default:
          break;
      }
    }
  };
  for (const block of file.blocks) {
    add(block.range);
    for (const s of block.sections) add(s.range);
    for (const n of block.networks) {
      add(n.range);
      if (n.statements) walk(n.statements);
    }
  }
  for (const t of file.tokens) if (t.kind === 3 /* BlockComment */) add(t, 'comment');
  return out;
}

// --- Semantic tokens -----------------------------------------------------------------------------

export const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'class',
  'struct',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'function',
  'type',
] as const;
export const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'readonly',
  'static',
  'defaultLibrary',
  'modification',
] as const;

export interface SemanticToken {
  readonly start: number;
  readonly length: number;
  readonly type: (typeof SEMANTIC_TOKEN_TYPES)[number];
  readonly modifiers: readonly (typeof SEMANTIC_TOKEN_MODIFIERS)[number][];
}

export function semanticTokens(project: Project, file: string): SemanticToken[] {
  const analysis = analyzeProject(project);
  const text = project.files.get(file)?.source.text;
  const out: SemanticToken[] = [];
  const memberCache = new Map<string, SectionKind | 'Return' | 'field' | undefined>();
  for (const r of analysis.references) {
    if (r.file !== file) continue;
    const mods: SemanticToken['modifiers'][number][] = [];
    if (r.access === 'declaration') mods.push('declaration');
    if (r.access === 'write' || r.access === 'readwrite') mods.push('modification');
    let type: SemanticToken['type'] | undefined;
    switch (r.symbolKind) {
      case 'member': {
        let section = memberCache.get(r.symbolId);
        if (!memberCache.has(r.symbolId)) {
          section = memberById(project, r.symbolId)?.member.section ?? 'field';
          memberCache.set(r.symbolId, section);
        }
        // a parameter is a 'parameter' where it is declared and where a call names it (Enable := …);
        // used with '#' it is a variable of the block, after '.' a member of another one
        const before = text?.[r.range.start - 1];
        if (section === 'Constant') {
          type = 'variable';
          mods.push('readonly');
        } else if (before === '.' || section === 'field' || section === undefined)
          type = 'property';
        else if (before === '#') type = 'variable';
        else if (section === 'Input' || section === 'Output' || section === 'InOut')
          type = 'parameter';
        else type = 'variable';
        break;
      }
      case 'block': {
        // a called block stays plain text, as in TIA ("FC_X"(…), an instance DB's call)
        if (text && /^\s*\(/.test(text.slice(r.range.end, r.range.end + 40))) break;
        const b = project.index.block(r.symbolId);
        type =
          b?.kind === 'FC'
            ? 'function'
            : b?.kind === 'UDT'
              ? 'struct'
              : b?.kind === 'DB'
                ? 'variable'
                : 'class';
        if (b?.kind === 'DB') mods.push('static');
        break;
      }
      case 'tag':
        type = 'variable';
        mods.push('static');
        break;
      case 'constant':
        type = 'enumMember';
        mods.push('readonly');
        break;
      case 'instruction':
        type = 'function';
        mods.push('defaultLibrary');
        break;
      default:
        break;
    }
    if (!type) continue;
    // a local's '#' takes the color of its name, as the grammar colors them together
    const local = text?.[r.range.start - 1] === '#' ? 1 : 0;
    out.push({
      start: r.range.start - local,
      length: r.range.end - r.range.start + local,
      type,
      modifiers: mods,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

// --- Inlay hints ---------------------------------------------------------------------------------

export interface InlayHintItem {
  readonly offset: number;
  readonly label: string;
}

/** Parameter names before non-formal (positional) arguments: ABS(IN: #x). */
export function inlayHints(
  project: Project,
  file: string,
  start: number,
  end: number,
  language?: string,
): InlayHintItem[] {
  const analysis = analyzeProject(project);
  const out: InlayHintItem[] = [];
  for (const call of analysis.calls) {
    if (call.file !== file || call.range.end < start || call.range.start > end) continue;
    const positional = call.args.filter((a) => a.direction === 'positional');
    if (positional.length === 0) continue;
    const block = blockAt(project, file, call.range.start);
    const signature = calleeSignature(project, block, calleeText(project, call), language);
    if (!signature) continue;
    const inputs = signature.parameters.filter((p) => p.direction !== 'out');
    positional.forEach((a, i) => {
      const p = inputs[i];
      if (p) out.push({ offset: a.value.range.start, label: `${p.name}:` });
    });
  }
  return out;
}

function calleeText(project: Project, call: CallSite): string {
  const text = project.files.get(call.file)?.source.text ?? '';
  const open = text.indexOf('(', call.range.start);
  return text.slice(call.range.start, open < 0 ? call.range.end : open).trim();
}

// --- Hover -------------------------------------------------------------------------------------

export interface HoverInfo {
  readonly range: Range;
  /** Markdown. */
  readonly contents: string;
}

// underscores inside words never start emphasis in Markdown, so names stay readable unescaped
const escape = (s: string) => s.replace(/[\\`*{}[\]<>|]/g, (c) => `\\${c}`);

export function hoverAt(
  project: Project,
  file: string,
  offset: number,
  language?: string,
  extra?: (symbolId: string) => string | undefined,
): HoverInfo | undefined {
  const ref = referenceAt(project, file, offset);
  if (!ref) return undefined;
  const d = describeSymbol(project, ref.symbolId);
  if (!d) return undefined;
  const lines: string[] = [];
  const prefix =
    d.kind === 'member'
      ? '#'
      : d.kind === 'block' || d.kind === 'tag' || d.kind === 'constant'
        ? '"'
        : '';
  const suffix = prefix === '"' ? '"' : '';
  lines.push(
    `**${escape(prefix + d.name + suffix)}** · ${escape(d.detail)}${d.typeText ? ` · \`${d.typeText}\`` : ''}`,
  );
  if (d.kind === 'instruction') {
    const signature = calleeSignature(project, blockAt(project, file, offset), d.name, language);
    if (signature) lines.push('```\n' + signature.label + '\n```');
    const instruction = project.profile.instruction(d.name);
    if (instruction?.helpUrl) lines.push(`[Siemens online help](${instruction.helpUrl})`);
  }
  if (d.initial !== undefined) lines.push(`Start value: \`${d.initial}\``);
  const text = pickText(d.comments, language);
  if (text) lines.push(escape(text));
  const others = [...d.comments].filter(([c, t]) => c !== '' && c !== language && t !== text);
  if (others.length > 0) lines.push(others.map(([c, t]) => `_${c}:_ ${escape(t)}`).join('  \n'));
  if (d.container) lines.push(`Declared in ${escape(d.container)}`);
  const more = extra?.(ref.symbolId);
  if (more) lines.push(more);
  return { range: ref.range, contents: lines.join('\n\n') };
}

// --- Code lens ---------------------------------------------------------------------------------

export interface CodeLensItem {
  readonly range: Range;
  readonly title: string;
  readonly symbolId: string;
}

export function codeLenses(
  project: Project,
  file: string,
  extra?: (block: BlockSymbol) => string | undefined,
): CodeLensItem[] {
  const analysis = analyzeProject(project);
  const out: CodeLensItem[] = [];
  for (const b of project.index.blocks) {
    if (b.file.path !== file) continue;
    const refs = (analysis.referencesBySymbol.get(b.id) ?? []).filter(
      (r) => r.access !== 'declaration' && r.blockId !== b.id,
    );
    const parts = [`${refs.length} reference${refs.length === 1 ? '' : 's'}`];
    const summary = extra?.(b);
    if (summary) parts.push(summary);
    out.push({ range: b.block.name.range, title: parts.join(' · '), symbolId: b.id });
  }
  return out;
}

// --- Call hierarchy ------------------------------------------------------------------------------

export interface CallHierarchyNode {
  readonly id: string;
  readonly name: string;
  readonly kind: Block['kind'];
  readonly file: string;
  readonly range: Range;
  readonly selectionRange: Range;
}

function node(b: BlockSymbol): CallHierarchyNode {
  return {
    id: b.id,
    name: b.namespace ? `${b.namespace}.${b.name}` : b.name,
    kind: b.kind,
    file: b.file.path,
    range: b.block.range,
    selectionRange: b.block.name.range,
  };
}

export function callHierarchyAt(
  project: Project,
  file: string,
  offset: number,
): CallHierarchyNode | undefined {
  const ref = referenceAt(project, file, offset);
  const id = ref?.symbolKind === 'block' ? ref.symbolId : blockAt(project, file, offset)?.id;
  const b = id ? project.index.block(id) : undefined;
  if (!b) return undefined;
  if (b.kind === 'DB' && b.dbKind === 'instance') {
    const fb = project.index.resolveType(b.block.dbType, b.namespace, b.id, b.file.path);
    const fbSymbol = fb.kind === 'fb' ? project.index.block(fb.block.id) : undefined;
    return fbSymbol ? node(fbSymbol) : node(b);
  }
  return node(b);
}

export function incomingCalls(
  project: Project,
  id: string,
): { from: CallHierarchyNode; ranges: Range[] }[] {
  const grouped = new Map<string, Range[]>();
  for (const c of analyzeProject(project).calls) {
    if (c.calleeId !== id) continue;
    grouped.set(c.callerId, [...(grouped.get(c.callerId) ?? []), c.range]);
  }
  return [...grouped].flatMap(([caller, ranges]) => {
    const b = project.index.block(caller);
    return b ? [{ from: node(b), ranges }] : [];
  });
}

export function outgoingCalls(
  project: Project,
  id: string,
): { to: CallHierarchyNode; ranges: Range[] }[] {
  const grouped = new Map<string, Range[]>();
  for (const c of analyzeProject(project).calls) {
    if (c.callerId !== id || !c.calleeId?.startsWith('block:')) continue;
    grouped.set(c.calleeId, [...(grouped.get(c.calleeId) ?? []), c.range]);
  }
  return [...grouped].flatMap(([callee, ranges]) => {
    const b = project.index.block(callee);
    return b ? [{ to: node(b), ranges }] : [];
  });
}

// --- Quick fixes -----------------------------------------------------------------------------

export interface QuickFix {
  readonly title: string;
  readonly edits: ReadonlyMap<string, readonly TextEdit[]>;
  readonly preferred?: boolean;
}

export interface DiagnosticRef {
  readonly code: string;
  readonly range: Range;
  readonly message: string;
}

const DEFAULT_VALUE: Record<string, string> = {
  Bool: 'FALSE',
  Int: '0',
  DInt: '0',
  Real: '0.0',
  LReal: '0.0',
  Time: 'T#0s',
  Word: '16#0',
  Byte: '16#0',
};

export function quickFixes(project: Project, file: string, diagnostic: DiagnosticRef): QuickFix[] {
  const source = project.files.get(file)?.source;
  if (!source) return [];
  const one = (title: string, edits: TextEdit[], preferred = false, target = file): QuickFix => ({
    title,
    edits: new Map([[target, edits]]),
    preferred,
  });
  switch (diagnostic.code) {
    case 'undeclared-local': {
      const name = source.text
        .slice(diagnostic.range.start, diagnostic.range.end)
        .replace(/^#"?|"$/g, '');
      const block = blockAt(project, file, diagnostic.range.start);
      if (!block) return [];
      const type = guessType(project, file, diagnostic.range);
      const sections: SectionKind[] =
        block.kind === 'FB'
          ? ['Temp', 'Static', 'Input', 'Output']
          : block.kind === 'FC'
            ? ['Temp', 'Input', 'Output']
            : ['Temp'];
      return sections.flatMap((s, i) => {
        const edit = declareMember(block, s, name, type);
        return edit
          ? [one(`Declare #${name} : ${type} in ${sectionKeyword(s)}`, [edit], i === 0)]
          : [];
      });
    }
    case 'missing-inout-parameter':
    case 'missing-fc-parameter': {
      const call = analyzeProject(project).calls.find(
        (c) =>
          c.file === file &&
          c.range.start === diagnostic.range.start &&
          c.range.end === diagnostic.range.end,
      );
      if (!call) return [];
      const block = blockAt(project, file, call.range.start);
      const signature = calleeSignature(project, block, calleeText(project, call));
      if (!signature) return [];
      const given = new Set(call.args.map((a) => a.parameter?.toLowerCase()));
      const missing = signature.parameters.filter((p) => !given.has(p.name.toLowerCase()));
      if (missing.length === 0) return [];
      const close = source.text.lastIndexOf(')', call.range.end);
      const sep = call.args.length > 0 ? ', ' : '';
      const text = missing
        .map(
          (p) =>
            `${p.name} ${p.direction === 'out' ? '=>' : ':='} ${p.direction === 'out' ? `#${p.name}` : (DEFAULT_VALUE[p.type] ?? `#${p.name}`)}`,
        )
        .join(', ');
      return [
        one(
          `Add the missing parameters (${missing.map((p) => p.name).join(', ')})`,
          [{ start: close, end: close, newText: sep + text }],
          true,
        ),
      ];
    }
    case 'implicit-conversion':
    case 'iec-implicit-conversion': {
      const m = /from (\w+) to (\w+)|(\w+) is not converted implicitly into (\w+)/.exec(
        diagnostic.message,
      );
      const from = m?.[1] ?? m?.[3];
      const to = m?.[2] ?? m?.[4];
      if (!from || !to) return [];
      const fn = `${from.toUpperCase()}_TO_${to.toUpperCase()}`;
      const value = source.text.slice(diagnostic.range.start, diagnostic.range.end);
      return [
        one(
          `Convert explicitly with ${fn}`,
          [
            {
              start: diagnostic.range.start,
              end: diagnostic.range.end,
              newText: `${fn}(${value})`,
            },
          ],
          true,
        ),
      ];
    }
    case 'unpublished-access': {
      const ref = analyzeProject(project).references.find(
        (r) =>
          r.file === file &&
          r.symbolKind === 'block' &&
          r.range.start >= diagnostic.range.start &&
          r.range.end <= diagnostic.range.end,
      );
      const target = ref ? project.index.block(ref.symbolId) : undefined;
      if (!target) return [];
      const attr = target.block.attributes.find(
        (a) => a.name === 'S7_UnitAccess' || a.name === 'Published',
      );
      if (!attr) return [];
      const quote = target.file.source.text[attr.valueRange.start];
      const value =
        attr.name === 'Published' ? `${quote}TRUE${quote}` : `${quote}Published${quote}`;
      return [
        one(
          `Publish ${target.name} (in ${target.file.relativePath}; publish it in TIA as well)`,
          [{ start: attr.valueRange.start, end: attr.valueRange.end, newText: value }],
          true,
          target.file.path,
        ),
      ];
    }
    case 'missing-relation': {
      const fromUnit = blockAt(project, file, diagnostic.range.start)?.unit;
      const m = /relation to unit (\S+);/.exec(diagnostic.message);
      const manifestPath = project.manifestPath;
      const manifestFile = manifestPath ? project.manifestText : undefined;
      if (!fromUnit || !m || !manifestPath || manifestFile === undefined) return [];
      const edit = addRelation(manifestFile, fromUnit.name, m[1]!);
      return edit
        ? [
            one(
              `Add a relation from ${fromUnit.name} to ${m[1]} in plc.json (and in TIA)`,
              [edit],
              true,
              manifestPath,
            ),
          ]
        : [];
    }
    default:
      return [];
  }
}

function sectionKeyword(s: SectionKind): string {
  return {
    Input: 'VAR_INPUT',
    Output: 'VAR_OUTPUT',
    InOut: 'VAR_IN_OUT',
    Static: 'VAR',
    Temp: 'VAR_TEMP',
    Constant: 'VAR CONSTANT',
  }[s];
}

/** The type of the value assigned to an undeclared variable, else Bool. */
function guessType(project: Project, file: string, range: Range): string {
  const text = project.files.get(file)!.source.text;
  const after = text.slice(range.end, text.indexOf('\n', range.end) >>> 0);
  const value = /^\s*:=\s*(.+?);/.exec(after)?.[1];
  if (!value) {
    const before = text.slice(text.lastIndexOf('\n', range.start) + 1, range.start);
    const m = /(#?"?[A-Za-z_][\w."]*)\s*:=\s*$/.exec(before);
    if (m) {
      const block = blockAt(project, file, range.start);
      const t = block ? describeTarget(project, block, m[1]!) : undefined;
      if (t) return t;
    }
    return 'Bool';
  }
  if (/^(TRUE|FALSE)$/i.test(value)) return 'Bool';
  if (/^-?\d+$/.test(value)) return 'Int';
  if (/^-?\d+\.\d+/.test(value)) return 'Real';
  if (/^T#/i.test(value)) return 'Time';
  if (/^'/.test(value)) return 'String';
  const block = blockAt(project, file, range.start);
  return (block && describeTarget(project, block, value)) || 'Bool';
}

function describeTarget(project: Project, block: BlockSymbol, text: string): string | undefined {
  const m = /^#"?([A-Za-z_]\w*)"?$/.exec(text.trim());
  if (!m) return undefined;
  const member = project.index
    .interfaceMembers(block)
    .find((x) => x.name.toLowerCase() === m[1]!.toLowerCase());
  return member ? typeName(member.type) : undefined;
}

/** Inserts a declaration at the end of a section, creating the section when needed. */
export function declareMember(
  block: BlockSymbol,
  section: SectionKind,
  name: string,
  type: string,
): TextEdit | undefined {
  const source = block.file.source;
  const nl = source.newline;
  const isSd = block.file.kind === 's7dcl';
  const blockIndent = /^[ \t]*/.exec(
    source.lineText(source.positionAt(block.block.range.start).line),
  )![0];
  const existing = block.block.sections.find(
    (s) => s.kind === section && (section !== 'Static' || !s.modifiers.includes('RETAIN')),
  );
  if (existing) {
    const endLine = source.positionAt(existing.range.end).line;
    const memberIndent = existing.members[0]
      ? /^[ \t]*/.exec(
          source.lineText(source.positionAt(existing.members[0].name.range.start).line),
        )![0]
      : blockIndent + (isSd ? '        ' : '      ');
    const at = source.lineStart(endLine);
    return { start: at, end: at, newText: `${memberIndent}${name} : ${type};${nl}` };
  }
  const indent = isSd ? blockIndent + '    ' : '   ';
  const memberIndent = isSd ? indent + '    ' : '      ';
  const text = `${indent}${sectionKeyword(section)}${nl}${memberIndent}${name} : ${type};${nl}${indent}END_VAR${nl}`;
  const last = block.block.sections.at(-1);
  if (last) {
    const at = source.lineStart(source.positionAt(last.range.end).line + 1);
    return { start: at, end: at, newText: text };
  }
  // no section yet: after the block header line (and its return type)
  const headerLine = source.positionAt(
    block.block.returnType?.range.end ?? block.block.name.range.end,
  ).line;
  const at = source.lineStart(headerLine + 1);
  return { start: at, end: at, newText: text };
}

/** Adds "to" to the relations of unit "from" in plc.json, touching only that array. */
export function addRelation(manifest: string, from: string, to: string): TextEdit | undefined {
  const nameAt = manifest.search(
    new RegExp(`"name"\\s*:\\s*"${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
  );
  if (nameAt < 0) return undefined;
  const objectEnd = manifest.indexOf('}', nameAt);
  const objectStart = manifest.lastIndexOf('{', nameAt);
  const relations = manifest.slice(objectStart, objectEnd).search(/"relations"\s*:\s*\[/);
  if (relations >= 0) {
    const open = manifest.indexOf('[', objectStart + relations);
    const close = manifest.indexOf(']', open);
    const empty = manifest.slice(open + 1, close).trim() === '';
    return { start: open + 1, end: open + 1, newText: empty ? `"${to}"` : `"${to}", ` };
  }
  const nameEnd = manifest.indexOf(',', nameAt);
  const insertAt = nameEnd >= 0 && nameEnd < objectEnd ? nameEnd + 1 : objectEnd;
  return {
    start: insertAt,
    end: insertAt,
    newText: ` "relations": ["${to}"]${nameEnd >= 0 && nameEnd < objectEnd ? ',' : ''}`,
  };
}

export type { Reference };
