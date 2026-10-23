// Edits on block interfaces and DB/UDT declarations, in TIA's own layout for each format:
// SIMATIC SD documents put member attributes in a { } block on the lines before the member and
// keep comments in the .s7res; external sources put attributes after the name and the comment
// at the end of the line (format-notes).
import type { ResourceFile } from '../formats/s7res.ts';
import { newResourceId } from '../formats/s7res.ts';
import type {
  Attribute,
  Block,
  BlockFile,
  Member,
  SectionKind,
  VarSection,
} from '../syntax/ast.ts';
import type { TextEdit } from '../writer/text-edit.ts';
import { afterLine, failed, indentOf, lineSpan, lineStartOf, type EditResult } from './common.ts';
import {
  addResourceEntry,
  newResourceFileText,
  removeResourceEntry,
  resourceText,
  setResourceText,
} from './resources.ts';

export interface DeclarationContext {
  readonly file: BlockFile;
  readonly block: Block;
  /** The .s7res next to a SIMATIC SD document, if there is one. */
  readonly resources?: ResourceFile | undefined;
}

export interface MemberLocation {
  readonly member: Member;
  /** The list the member is in (a section's members or a struct's members). */
  readonly siblings: readonly Member[];
  /** The top-level section; undefined for UDT members. */
  readonly section: VarSection | undefined;
}

export interface MemberFlags {
  /** Only for Static members and DB members: in a RETAIN section. */
  readonly retain: boolean | undefined;
  readonly accessible: boolean;
  readonly visible: boolean;
  readonly writable: boolean;
  readonly setpoint: boolean;
}

export interface MemberSpec {
  readonly name: string;
  readonly type: string;
  readonly initial?: string | undefined;
  readonly comment?: string | undefined;
}

const SECTION_ORDER: readonly SectionKind[] = [
  'Input',
  'Output',
  'InOut',
  'Static',
  'Temp',
  'Constant',
];
const SECTION_KEYWORD: Readonly<Record<SectionKind, string>> = {
  Input: 'VAR_INPUT',
  Output: 'VAR_OUTPUT',
  InOut: 'VAR_IN_OUT',
  Static: 'VAR',
  Temp: 'VAR_TEMP',
  Constant: 'VAR CONSTANT',
};

const isSd = (ctx: DeclarationContext) => ctx.file.format === 's7dcl';

// --- Finding members ------------------------------------------------------------------------

/** Finds a member by its path (top-level name, then struct member names), case-insensitive. */
export function findMember(block: Block, path: readonly string[]): MemberLocation | undefined {
  if (path.length === 0) return undefined;
  const top: { members: readonly Member[]; section: VarSection | undefined }[] = block.struct
    ? [{ members: block.struct.members, section: undefined }]
    : block.sections.map((s) => ({ members: s.members, section: s }));
  for (const { members, section } of top) {
    let siblings = members;
    let found: Member | undefined;
    for (let i = 0; i < path.length; i++) {
      found = siblings.find((m) => m.name.text.toLowerCase() === path[i]!.toLowerCase());
      if (!found) break;
      if (i < path.length - 1) {
        if (found.type.kind !== 'struct') {
          found = undefined;
          break;
        }
        siblings = found.type.members;
      }
    }
    if (found) return { member: found, siblings, section };
  }
  return undefined;
}

/** The full lines a member occupies: attribute block, declaration and trailing comment. */
export function memberLines(
  ctx: DeclarationContext,
  member: Member,
): { start: number; end: number } {
  const end = Math.max(member.range.end, member.comment?.range.end ?? 0);
  return lineSpan(ctx.file.source, { start: member.range.start, end });
}

// --- Reading -----------------------------------------------------------------------------

const attr = (member: Member, name: string) =>
  member.attributes.find((a) => a.name.toLowerCase() === name.toLowerCase());

export function memberFlags(ctx: DeclarationContext, location: MemberLocation): MemberFlags {
  const m = location.member;
  const modifiers = location.section?.modifiers ?? [];
  const retainable = location.section?.kind === 'Static';
  const retain = retainable ? modifiers.includes('RETAIN') : undefined;
  if (isSd(ctx)) {
    const visible = !/hidden/i.test(attr(m, 'S7_Visibility')?.value ?? '');
    const writable = !/readonly/i.test(attr(m, 'S7_Access')?.value ?? '');
    return {
      retain,
      accessible: visible || writable,
      visible,
      writable,
      setpoint: /^true$/i.test(attr(m, 'S7_Setpoint')?.value ?? ''),
    };
  }
  const flag = (name: string) => !/^false$/i.test(attr(m, name)?.value ?? '');
  return {
    retain,
    accessible: flag('ExternalAccessible'),
    visible: flag('ExternalVisible'),
    writable: flag('ExternalWritable'),
    setpoint: /^true$/i.test(attr(m, 'S7_SetPoint')?.value ?? ''),
  };
}

/** The member's comment in a culture: from the .s7res (SIMATIC SD) or the line comment (source). */
export function memberComment(
  ctx: DeclarationContext,
  member: Member,
  culture: string,
): string | undefined {
  if (isSd(ctx)) return resourceText(ctx.resources, attr(member, 'S7_MLC')?.value, culture);
  return member.comment?.text;
}

// --- Attribute blocks --------------------------------------------------------------------

interface Attr {
  readonly name: string;
  readonly value: string;
}

/** A SIMATIC SD attribute block as TIA writes it: one line for one attribute, else sorted lines. */
function sdAttributeBlock(indent: string, attrs: readonly Attr[], nl: string): string {
  const sorted = [...attrs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (sorted.length === 0) return '';
  if (sorted.length === 1) return `${indent}{ ${sorted[0]!.name} := "${sorted[0]!.value}" }${nl}`;
  return `${indent}{${nl}${sorted.map((a, i) => `${indent}    ${a.name} := "${a.value}"${i < sorted.length - 1 ? ';' : ''}${nl}`).join('')}${indent}}${nl}`;
}

/** An external-source attribute block as TIA writes it: { A := 'x'; B := 'y'} */
function sourceAttributeBlock(attrs: readonly Attr[]): string {
  return attrs.length === 0 ? '' : `{ ${attrs.map((a) => `${a.name} := '${a.value}'`).join('; ')}}`;
}

/** Replaces a member's attributes with a new set, in the file's own form. */
function setAttributes(
  ctx: DeclarationContext,
  member: Member,
  attrs: readonly Attr[],
): TextEdit[] {
  const source = ctx.file.source;
  const nl = source.newline;
  if (isSd(ctx)) {
    const nameLine = lineStartOf(source, member.name.range.start);
    const indent = indentOf(source, member.name.range.start);
    const text = sdAttributeBlock(indent, attrs, nl);
    if (member.attributeBlock) {
      const span = lineSpan(source, member.attributeBlock.range);
      return [{ start: span.start, end: span.end, newText: text }];
    }
    return text ? [{ start: nameLine, end: nameLine, newText: text }] : [];
  }
  const block = sourceAttributeBlock(attrs);
  if (member.attributeBlock) {
    // remove the space before the block as well when the block goes away
    const start =
      block === '' && source.text[member.attributeBlock.range.start - 1] === ' '
        ? member.attributeBlock.range.start - 1
        : member.attributeBlock.range.start;
    return [{ start, end: member.attributeBlock.range.end, newText: block }];
  }
  return block
    ? [{ start: member.name.range.end, end: member.name.range.end, newText: ` ${block}` }]
    : [];
}

function currentAttrs(member: Member): Attr[] {
  return member.attributes.map((a: Attribute) => ({ name: a.name, value: a.value }));
}

function withAttr(attrs: Attr[], name: string, value: string | undefined): Attr[] {
  const rest = attrs.filter((a) => a.name.toLowerCase() !== name.toLowerCase());
  return value === undefined ? rest : [...rest, { name, value }];
}

// --- Operations ----------------------------------------------------------------------------

export function setMemberFlags(
  ctx: DeclarationContext,
  path: readonly string[],
  changes: Partial<MemberFlags>,
): EditResult {
  const location = findMember(ctx.block, path);
  if (!location) return failed(`No member ${path.join('.')}.`);
  const current = memberFlags(ctx, location);
  const next: { -readonly [K in keyof MemberFlags]: MemberFlags[K] } = { ...current, ...changes };
  if (changes.accessible === false) {
    next.visible = false;
    next.writable = false;
  }
  if ((changes.visible === true || changes.writable === true) && changes.accessible === undefined)
    next.accessible = true;
  let attrs = currentAttrs(location.member);
  if (isSd(ctx)) {
    attrs = withAttr(attrs, 'S7_Access', next.writable ? undefined : 'ReadOnly := External');
    attrs = withAttr(attrs, 'S7_Visibility', next.visible ? undefined : 'Hidden := External');
    attrs = withAttr(attrs, 'S7_Setpoint', next.setpoint ? 'True' : undefined);
  } else {
    attrs = withAttr(attrs, 'ExternalAccessible', next.accessible ? undefined : 'False');
    attrs = withAttr(attrs, 'ExternalVisible', next.visible ? undefined : 'False');
    attrs = withAttr(attrs, 'ExternalWritable', next.writable ? undefined : 'False');
    attrs = withAttr(attrs, 'S7_SetPoint', next.setpoint ? 'True' : undefined);
    // TIA writes them in this order
    const order = ['ExternalAccessible', 'ExternalVisible', 'ExternalWritable', 'S7_SetPoint'];
    attrs.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
  const unchangedAttrs = JSON.stringify(currentAttrs(location.member)) === JSON.stringify(attrs);
  const edits = unchangedAttrs ? [] : setAttributes(ctx, location.member, attrs);
  if (
    changes.retain !== undefined &&
    changes.retain !== current.retain &&
    current.retain !== undefined &&
    path.length === 1
  ) {
    const moved = moveToRetainSection(ctx, location, changes.retain, edits);
    if (moved.error) return moved;
    return moved;
  }
  return { edits };
}

/** Moves a Static/DB member into the RETAIN (or plain) VAR section; creates the section if needed. */
function moveToRetainSection(
  ctx: DeclarationContext,
  location: MemberLocation,
  retain: boolean,
  attrEdits: TextEdit[],
): EditResult {
  const source = ctx.file.source;
  const nl = source.newline;
  const span = memberLines(ctx, location.member);
  // apply the attribute edits to the moved text
  let text = source.text.slice(span.start, span.end);
  for (const e of [...attrEdits].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, e.start - span.start) + e.newText + text.slice(e.end - span.start);
  }
  const target = ctx.block.sections.find(
    (s) =>
      s.kind === 'Static' &&
      s.modifiers.includes('RETAIN') === retain &&
      !s.modifiers.includes('CONSTANT'),
  );
  const remove: TextEdit = { start: span.start, end: span.end, newText: '' };
  if (target) {
    const at = lineStartOf(source, target.range.end - 'END_VAR'.length);
    return { edits: [remove, { start: at, end: at, newText: text }] };
  }
  const from = location.section!;
  const header = indentOf(source, from.range.start);
  // TIA: "VAR RETAIN" (no trailing space) after the plain VAR section; SIMATIC SD leaves a blank line
  const keyword = retain ? 'VAR RETAIN' : isSd(ctx) ? 'VAR' : 'VAR ';
  const sectionText = `${isSd(ctx) ? nl : ''}${header}${keyword}${nl}${text}${header}END_VAR${nl}`;
  const at = afterLine(source, from.range.end);
  return { edits: [remove, { start: at, end: at, newText: sectionText }] };
}

export function retypeMember(
  ctx: DeclarationContext,
  path: readonly string[],
  typeText: string,
): EditResult {
  const location = findMember(ctx.block, path);
  if (!location) return failed(`No member ${path.join('.')}.`);
  if (typeText.trim() === '') return failed('The data type cannot be empty.');
  const t = location.member.type;
  return { edits: [{ start: t.range.start, end: t.range.end, newText: typeText.trim() }] };
}

/** Sets or removes the declared default value (` := value` in the declaration). */
export function setDefaultValue(
  ctx: DeclarationContext,
  path: readonly string[],
  value: string | undefined,
): EditResult {
  const location = findMember(ctx.block, path);
  if (!location) return failed(`No member ${path.join('.')}.`);
  const m = location.member;
  const v = value?.trim();
  if (m.initial) {
    if (!v) return { edits: [{ start: m.type.range.end, end: m.initial.range.end, newText: '' }] };
    return { edits: [{ start: m.initial.range.start, end: m.initial.range.end, newText: v }] };
  }
  if (!v) return { edits: [] };
  return { edits: [{ start: m.type.range.end, end: m.type.range.end, newText: ` := ${v}` }] };
}

export function setMemberComment(
  ctx: DeclarationContext,
  path: readonly string[],
  culture: string,
  text: string,
): EditResult {
  const location = findMember(ctx.block, path);
  if (!location) return failed(`No member ${path.join('.')}.`);
  const m = location.member;
  const source = ctx.file.source;
  if (!isSd(ctx)) {
    const clean = text.replace(/[\r\n]+/g, ' ').trim();
    if (m.comment) {
      if (!clean) {
        let start = m.comment.range.start;
        while (start > m.range.end && source.text[start - 1] === ' ') start--;
        return { edits: [{ start, end: m.comment.range.end, newText: '' }] };
      }
      return {
        edits: [{ start: m.comment.range.start, end: m.comment.range.end, newText: `// ${clean}` }],
      };
    }
    return clean
      ? { edits: [{ start: m.range.end, end: m.range.end, newText: `   // ${clean}` }] }
      : { edits: [] };
  }
  const id = attr(m, 'S7_MLC')?.value;
  if (id) {
    if (ctx.resources)
      return { edits: [], resourceEdits: setResourceText(ctx.resources, id, culture, text) };
    return text
      ? {
          edits: [],
          newResourceText: newResourceFileText(
            [{ id, values: { [culture]: text } }],
            source.newline,
          ),
        }
      : { edits: [] };
  }
  if (!text) return { edits: [] };
  const newId = newResourceId(allResourceIds(ctx));
  const edits = setAttributes(ctx, m, withAttr(currentAttrs(m), 'S7_MLC', newId));
  if (ctx.resources)
    return { edits, resourceEdits: addResourceEntry(ctx.resources, newId, { [culture]: text }) };
  return {
    edits,
    newResourceText: newResourceFileText(
      [{ id: newId, values: { [culture]: text } }],
      source.newline,
    ),
  };
}

function allResourceIds(ctx: DeclarationContext): string[] {
  const ids = new Set(ctx.resources?.entries.map((e) => e.id) ?? []);
  // ids referenced by the document but missing in the .s7res are taken too
  for (const m of ctx.file.source.text.matchAll(
    /S7_(?:MLC|NetworkTitle|NetworkComment)\s*:=\s*"([^"]+)"/g,
  ))
    ids.add(m[1]!);
  return [...ids];
}

/** Adds a member to a section (created in TIA's order if missing), after `afterPath` or at the end. */
export function addMember(
  ctx: DeclarationContext,
  sectionKind: SectionKind,
  spec: MemberSpec,
  options: { after?: readonly string[]; culture?: string; retain?: boolean } = {},
): EditResult {
  const source = ctx.file.source;
  const nl = source.newline;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.name))
    return failed(`${spec.name} is not a valid name.`);
  if (!spec.type.trim()) return failed('A data type is needed.');
  const sd = isSd(ctx);
  const allMembers = ctx.block.struct
    ? ctx.block.struct.members
    : ctx.block.sections.flatMap((s) => s.members);
  if (allMembers.some((m) => m.name.text.toLowerCase() === spec.name.toLowerCase()))
    return failed(`${spec.name} is already declared in this block.`);

  let insertAt: number;
  let indent: string;
  let sectionText: ((members: string) => string) | undefined;
  const step = sd ? '    ' : '   ';
  const afterLocation = options.after ? findMember(ctx.block, options.after) : undefined;
  if (afterLocation) {
    insertAt = memberLines(ctx, afterLocation.member).end;
    indent = indentOf(source, afterLocation.member.name.range.start);
  } else if (ctx.block.struct) {
    const endStruct = ctx.block.struct.range.end - 'END_STRUCT'.length;
    const first = ctx.block.struct.members[0];
    insertAt = lineStartOf(source, endStruct);
    indent = first ? indentOf(source, first.name.range.start) : indentOf(source, endStruct) + step;
  } else {
    const section = ctx.block.sections.find(
      (s) =>
        s.kind === sectionKind &&
        (options.retain === undefined || s.modifiers.includes('RETAIN') === options.retain),
    );
    if (section) {
      const first = section.members[0];
      insertAt = lineStartOf(source, section.range.end - 'END_VAR'.length);
      indent = first
        ? indentOf(source, first.name.range.start)
        : indentOf(source, section.range.start) + step;
    } else {
      // a new section, in TIA's order
      const order = SECTION_ORDER.indexOf(sectionKind);
      const before = [...ctx.block.sections]
        .reverse()
        .find((s) => SECTION_ORDER.indexOf(s.kind) <= order);
      const after = ctx.block.sections.find((s) => SECTION_ORDER.indexOf(s.kind) > order);
      const headerIndent = ctx.block.sections[0]
        ? indentOf(source, ctx.block.sections[0].range.start)
        : indentOf(source, ctx.block.range.start) + step;
      indent = headerIndent + step;
      const keyword =
        sectionKind === 'Static' && options.retain ? 'VAR RETAIN' : SECTION_KEYWORD[sectionKind];
      // external sources: "VAR_INPUT " with a trailing space and a blank line after END_VAR
      sectionText = (members) =>
        `${headerIndent}${keyword}${sd || keyword === 'VAR RETAIN' ? '' : ' '}${nl}${members}${headerIndent}END_VAR${nl}${sd ? '' : nl}`;
      if (before) insertAt = afterLine(source, before.range.end);
      else if (after) insertAt = lineStartOf(source, after.range.start);
      else if (sd) insertAt = afterLine(source, ctx.block.name.range.end);
      else insertAt = lineStartOf(source, ctx.block.codeStart);
      if (!sd && before) {
        const nextLine = source.positionAt(insertAt).line;
        if (nextLine < source.lineCount && source.lineText(nextLine).trim() === '')
          insertAt = afterLine(source, insertAt);
      }
    }
  }
  const initial = spec.initial?.trim() ? ` := ${spec.initial.trim()}` : '';
  let resourceEdits: readonly TextEdit[] | undefined;
  let newResourceText: string | undefined;
  let lines: string;
  if (sd) {
    let attrs = '';
    if (spec.comment?.trim()) {
      const id = newResourceId(allResourceIds(ctx));
      attrs = `${indent}{ S7_MLC := "${id}" }${nl}`;
      const culture = options.culture ?? 'en-US';
      if (ctx.resources)
        resourceEdits = addResourceEntry(ctx.resources, id, { [culture]: spec.comment.trim() });
      else
        newResourceText = newResourceFileText(
          [{ id, values: { [culture]: spec.comment.trim() } }],
          nl,
        );
    }
    lines = `${attrs}${indent}${spec.name} : ${spec.type.trim()}${initial};${nl}`;
  } else {
    const comment = spec.comment?.trim()
      ? `   // ${spec.comment.trim().replace(/[\r\n]+/g, ' ')}`
      : '';
    lines = `${indent}${spec.name} : ${spec.type.trim()}${initial};${comment}${nl}`;
  }
  const newText = sectionText ? sectionText(lines) : lines;
  const result: EditResult = { edits: [{ start: insertAt, end: insertAt, newText }] };
  return {
    ...result,
    ...(resourceEdits ? { resourceEdits } : {}),
    ...(newResourceText ? { newResourceText } : {}),
  };
}

/** Deletes a member, its start value lines (DBs) and its .s7res entry. */
export function deleteMember(ctx: DeclarationContext, path: readonly string[]): EditResult {
  const location = findMember(ctx.block, path);
  if (!location) return failed(`No member ${path.join('.')}.`);
  const span = memberLines(ctx, location.member);
  const edits: TextEdit[] = [{ start: span.start, end: span.end, newText: '' }];
  const prefix = path.join('.').toLowerCase();
  for (const sv of ctx.block.startValues) {
    const target = ctx.file.source.slice(sv.target.range).replace(/\s+/g, '').toLowerCase();
    if (target === prefix || target.startsWith(prefix + '.') || target.startsWith(prefix + '[')) {
      const s = lineSpan(ctx.file.source, sv.range);
      edits.push({ start: s.start, end: s.end, newText: '' });
    }
  }
  const id = attr(location.member, 'S7_MLC')?.value;
  const resourceEdits = id && ctx.resources ? removeResourceEntry(ctx.resources, id) : undefined;
  return resourceEdits && resourceEdits.length > 0 ? { edits, resourceEdits } : { edits };
}

/** Moves a member one place up (-1) or down (+1) among its siblings. */
export function moveMember(
  ctx: DeclarationContext,
  path: readonly string[],
  direction: -1 | 1,
): EditResult {
  const location = findMember(ctx.block, path);
  if (!location) return failed(`No member ${path.join('.')}.`);
  const i = location.siblings.indexOf(location.member);
  const j = i + direction;
  if (j < 0 || j >= location.siblings.length)
    return failed('The member is already at the edge of its section.');
  const a = memberLines(ctx, location.siblings[Math.min(i, j)]!);
  const b = memberLines(ctx, location.siblings[Math.max(i, j)]!);
  const source = ctx.file.source.text;
  const between = source.slice(a.end, b.start);
  return {
    edits: [
      {
        start: a.start,
        end: b.end,
        newText: source.slice(b.start, b.end) + between + source.slice(a.start, a.end),
      },
    ],
  };
}
