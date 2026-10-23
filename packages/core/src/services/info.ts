// What the editor shows about a symbol: kind, type, initial value, declaration and comments in
// every language (spec, "Hover" and "Multilingual comments").
import type { Member } from '../syntax/ast.ts';
import type { BlockSymbol, Project, TagSymbol } from '../model/project.ts';
import { membersOf, typeName, type DataType, type MemberInfo } from '../model/types.ts';
import type { Range } from '../text/source-text.ts';

export interface SymbolDescription {
  readonly id: string;
  readonly name: string;
  readonly kind: 'block' | 'member' | 'tag' | 'constant' | 'instruction' | 'label';
  /** OB, FB, FC, DB, UDT for blocks; section for members. */
  readonly detail: string;
  readonly type: DataType | undefined;
  readonly typeText: string | undefined;
  readonly initial: string | undefined;
  readonly declaration: { readonly file: string; readonly range: Range } | undefined;
  /** Comments by culture (one entry with culture '' for single-language comments). */
  readonly comments: ReadonlyMap<string, string>;
  readonly container: string | undefined;
  readonly block: BlockSymbol | undefined;
  readonly tag: TagSymbol | undefined;
}

/** The block whose text contains an offset. */
export function blockAt(project: Project, file: string, offset: number): BlockSymbol | undefined {
  let best: BlockSymbol | undefined;
  for (const b of project.index.blocks) {
    if (b.file.path !== file || offset < b.block.range.start || offset > b.block.range.end)
      continue;
    if (
      !best ||
      b.block.range.end - b.block.range.start < best.block.range.end - best.block.range.start
    )
      best = b;
  }
  return best;
}

/** Members visible as #name inside a block. */
export function scopeMembers(project: Project, block: BlockSymbol): readonly MemberInfo[] {
  return block.kind === 'DB'
    ? project.index.dbMembers(block)
    : project.index.interfaceMembers(block);
}

/** Finds a member by its symbol id (member:block/a/b). */
export function memberById(
  project: Project,
  id: string,
): { member: MemberInfo; block: BlockSymbol } | undefined {
  if (!id.startsWith('member:')) return undefined;
  const parts = id.slice('member:'.length).split('/');
  const block = project.index.block(`block:${parts[0]}`);
  if (!block) return undefined;
  let members: readonly MemberInfo[] | undefined =
    block.kind === 'UDT' ? membersOf(project.index.udtType(block)) : scopeMembers(project, block);
  let found: MemberInfo | undefined;
  for (const name of parts.slice(1)) {
    found = members?.find((m) => m.name.toLowerCase() === name);
    if (!found) return undefined;
    members =
      membersOf(found.type) ??
      (found.type.kind === 'array' ? membersOf(found.type.element) : undefined);
  }
  return found ? { member: found, block } : undefined;
}

/** Comments of a member: the .s7res texts behind S7_MLC, or the trailing // comment of a source. */
export function memberComments(
  project: Project,
  block: BlockSymbol,
  node: Member | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!node) return out;
  const id = node.attributes.find((a) => a.name === 'S7_MLC')?.value;
  if (id) {
    const res = project.index.resourcesFor(block.file);
    const entry = res?.entries.find((e) => e.id === id);
    for (const v of entry?.values ?? []) out.set(v.culture, v.text);
  } else if (node.comment) {
    out.set('', node.comment.text);
  }
  return out;
}

/** Text in the display language, falling back to the first language that has one. */
export function pickText(
  texts: ReadonlyMap<string, string>,
  displayLanguage: string | undefined,
): string | undefined {
  if (texts.size === 0) return undefined;
  if (displayLanguage && texts.has(displayLanguage)) return texts.get(displayLanguage);
  if (texts.has('')) return texts.get('');
  return [...texts.values()][0];
}

export function describeSymbol(project: Project, symbolId: string): SymbolDescription | undefined {
  const base = {
    comments: new Map<string, string>(),
    container: undefined,
    block: undefined,
    tag: undefined,
    initial: undefined,
  };
  if (symbolId.startsWith('block:')) {
    const block = project.index.block(symbolId);
    if (!block) return undefined;
    const detail = block.kind === 'DB' ? `${block.dbKind ?? 'global'} DB` : block.kind;
    const returnType =
      block.kind === 'FC'
        ? project.index.resolveType(
            block.block.returnType,
            block.namespace,
            block.id,
            block.file.path,
          )
        : undefined;
    const comments = new Map<string, string>();
    if (block.block.title) comments.set('', block.block.title.text);
    return {
      ...base,
      id: symbolId,
      name: block.namespace ? `${block.namespace}.${block.name}` : block.name,
      kind: 'block',
      detail: block.failsafe ? `fail-safe ${detail}` : detail,
      type: returnType,
      typeText: returnType
        ? typeName(returnType)
        : block.dbKind === 'instance' && block.block.dbType
          ? project.index.resolveType(
              block.block.dbType,
              block.namespace,
              block.id,
              block.file.path,
            ).kind === 'fb'
            ? `instance of ${typeName(project.index.resolveType(block.block.dbType, block.namespace, block.id, block.file.path))}`
            : undefined
          : undefined,
      declaration: { file: block.file.path, range: block.block.name.range },
      comments,
      block,
    };
  }
  if (symbolId.startsWith('member:')) {
    const hit = memberById(project, symbolId);
    if (!hit) return undefined;
    const { member, block } = hit;
    const initial = member.node?.initial
      ? block.file.source.text.slice(member.node.initial.range.start, member.node.initial.range.end)
      : startValueOf(block, member.name);
    return {
      ...base,
      id: symbolId,
      name: member.name,
      kind: 'member',
      detail: member.section ?? 'member',
      type: member.type,
      typeText: typeName(member.type),
      initial,
      declaration: member.declaration,
      comments: memberComments(project, block, member.node),
      container: block.namespace ? `${block.namespace}.${block.name}` : block.name,
      block,
    };
  }
  if (symbolId.startsWith('tag:') || symbolId.startsWith('constant:')) {
    const tag = project.index.findTag(symbolId.slice(symbolId.indexOf(':') + 1));
    if (!tag) return undefined;
    const comments = new Map<string, string>();
    for (const [c, v] of tag.entry.comments) comments.set(c, v.text);
    return {
      ...base,
      id: symbolId,
      name: tag.name,
      kind: tag.kind === 'tag' ? 'tag' : 'constant',
      detail: tag.kind === 'tag' ? `PLC tag ${tag.entry.address ?? ''}`.trim() : 'user constant',
      type: project.index.tagType(tag),
      typeText: tag.entry.dataType,
      initial: tag.entry.value,
      declaration: { file: tag.file.path, range: tag.entry.nameRange },
      comments,
      container: tag.table.name,
      tag,
    };
  }
  if (symbolId.startsWith('instruction:')) {
    const name = symbolId.slice('instruction:'.length);
    const instruction = project.profile.instruction(name);
    const conversion = project.profile.conversion(name);
    const comments = new Map<string, string>();
    if (instruction) comments.set('', instruction.description);
    else if (conversion)
      comments.set('', `Converts ${conversion.from.name} into ${conversion.to.name}.`);
    return {
      ...base,
      id: symbolId,
      name: instruction?.name ?? name,
      kind: 'instruction',
      detail: instruction?.kind === 'fb' ? 'system function block' : 'system instruction',
      type: undefined,
      typeText: undefined,
      declaration: undefined,
      comments,
    };
  }
  return undefined;
}

function startValueOf(block: BlockSymbol, name: string): string | undefined {
  const sv = block.block.startValues.find(
    (s) => s.target.kind === 'name' && s.target.name.text.toLowerCase() === name.toLowerCase(),
  );
  return sv ? block.file.source.text.slice(sv.value.range.start, sv.value.range.end) : undefined;
}
