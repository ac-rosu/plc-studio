// Models and edit computation of the table editors (spec M7), free of the VS Code API so they can
// be tested on corpus files. tables.ts wraps them for VS Code.
import {
  addMember,
  blockId,
  deleteMember,
  findMember,
  memberComment,
  memberFlags,
  memberId,
  moveMember,
  newResourceFileText,
  renameEdits,
  resourceText,
  retypeMember,
  setDefaultValue,
  setMemberComment,
  setMemberFlags,
  setResourceText,
  setReturnType,
  setStartValue,
  startValueText,
  typeName,
  validateStartValue,
  type Block,
  type BlockFile,
  type BlockSymbol,
  type DataType,
  type DeclarationContext,
  type EditResult,
  type Member,
  type MemberInfo,
  type Project,
  type ProjectFile,
  type ResourceFile,
  type SectionKind,
} from '@plcstudio/core';

export interface ViewDiagnostic {
  readonly start: number;
  readonly end: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
}

/** What a model needs from the host. */
export interface ModelInput {
  readonly project: Project;
  readonly path: string;
  /** Every language of the project (sorted). */
  readonly cultures: readonly string[];
  /** The display language. */
  readonly culture: string;
  readonly diagnostics: readonly ViewDiagnostic[];
}

export type Message = { type: string; [key: string]: unknown };

export interface Row {
  readonly path: string[];
  readonly level: number;
  readonly name: string;
  readonly type: string;
  /** Default value (declaration) or, in the DB editor, the start value. */
  readonly value: string;
  readonly defaultValue: string;
  readonly retain: boolean | null;
  readonly accessible: boolean;
  readonly visible: boolean;
  readonly writable: boolean;
  readonly setpoint: boolean;
  readonly comment: string;
  readonly start: number;
  readonly end: number;
  readonly structured: boolean;
  /** Names, types and flags can be changed (false in instance DBs and for array elements). */
  readonly declarationEditable: boolean;
  /** The start value can be changed; false where no TIA sample shows how it is written. */
  readonly valueEditable?: boolean;
  readonly problems: string[];
}

export interface BlockContext {
  readonly project: Project;
  readonly file: ProjectFile;
  readonly parsed: BlockFile;
  readonly block: Block;
  /** Position of the block in its file (an external source can hold several, C42). */
  readonly blockIndex: number;
  readonly symbol: BlockSymbol | undefined;
  readonly resources: ResourceFile | undefined;
  readonly culture: string;
  readonly cultures: string[];
  readonly diagnostics: readonly ViewDiagnostic[];
}

export function blockContext(input: ModelInput, blockIndex = 0): BlockContext | string {
  const { project, path } = input;
  const file = project.files.get(path);
  if (!file?.parsed || file.parsed.kind !== 'blocks')
    return 'This file is not a block that PLC Studio can read.';
  const block = file.parsed.blocks[blockIndex];
  if (!block)
    return blockIndex === 0
      ? 'The file contains no block.'
      : 'This block is no longer in the file.';
  const symbol = project.index.blocks.find((b) => b.file.path === path && b.block === block);
  const cultures = [...input.cultures];
  if (!cultures.includes(input.culture)) cultures.push(input.culture);
  return {
    project,
    file,
    parsed: file.parsed,
    block,
    blockIndex,
    symbol,
    resources: project.index.resourcesFor(file),
    culture: input.culture,
    cultures: cultures.sort(),
    diagnostics: input.diagnostics,
  };
}

/** What a table view shows: one model per block of the file, in file order. */
export interface FileModel<M> {
  readonly blocks: readonly M[];
}

/** Positions of the blocks a view shows; [0] when none fits, so that model reports why. */
function blockIndexes(input: ModelInput, accept: (block: Block) => boolean): number[] {
  const parsed = input.project.files.get(input.path)?.parsed;
  if (parsed?.kind !== 'blocks') return [0];
  const indexes = parsed.blocks.flatMap((b, i) => (accept(b) ? [i] : []));
  return indexes.length > 0 ? indexes : [0];
}

const declContext = (c: BlockContext): DeclarationContext => ({
  file: c.parsed,
  block: c.block,
  resources: c.resources,
});

function typeText(c: BlockContext, m: Member): string {
  return m.type.kind === 'struct' ? 'Struct' : c.parsed.source.slice(m.type.range);
}

export function typeCompletions(project: Project): string[] {
  const p = project.profile;
  const names = new Set<string>();
  for (const t of p.profile.elementaryTypes) if (t.class !== 'void') names.add(t.name);
  for (const t of p.profile.systemTypes) names.add(t.name);
  for (const b of project.index.blocks) {
    if (b.kind === 'UDT' || b.kind === 'FB')
      names.add(b.namespace ? `_.${b.namespace}.${b.name}` : `"${b.name}"`);
  }
  for (const extra of ['Array[0..9] of Int', 'String[32]', 'Struct']) names.add(extra);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function problemsIn(diagnostics: readonly ViewDiagnostic[], start: number, end: number): string[] {
  return diagnostics
    .filter((d) => d.severity !== 'info' && d.start >= start && d.start <= end)
    .map((d) => d.message);
}

/** Member rows of a declaration list, struct members nested below their parent. */
function memberRows(
  c: BlockContext,
  members: readonly Member[],
  prefix: string[],
  level: number,
  out: Row[],
): void {
  const dctx = declContext(c);
  for (const m of members) {
    const path = [...prefix, m.name.text];
    const location = findMember(c.block, path);
    const flags = location
      ? memberFlags(dctx, location)
      : { retain: undefined, accessible: true, visible: true, writable: true, setpoint: false };
    const value = m.initial ? c.parsed.source.slice(m.initial.range) : '';
    out.push({
      path,
      level,
      name: m.name.text,
      type: typeText(c, m),
      value,
      defaultValue: value,
      retain: flags.retain ?? null,
      accessible: flags.accessible,
      visible: flags.visible,
      writable: flags.writable,
      setpoint: flags.setpoint,
      comment: memberComment(dctx, m, c.culture) ?? '',
      start: m.range.start,
      end: m.range.end,
      structured: m.type.kind === 'struct',
      declarationEditable: true,
      problems: problemsIn(c.diagnostics, m.range.start, m.range.end),
    });
    if (m.type.kind === 'struct') memberRows(c, m.type.members, path, level + 1, out);
  }
}

// --- Interface editor ----------------------------------------------------------------------------

export interface InterfaceModel {
  readonly view: 'interface';
  readonly blockIndex: number;
  readonly blockName: string;
  readonly blockKind: string;
  readonly format: 's7dcl' | 'source' | 'simaticml';
  /** A SimaticML export: shown, never edited (ADR 0014). */
  readonly readOnly?: boolean;
  readonly failsafe: boolean;
  readonly culture: string;
  readonly sections: {
    kind: SectionKind | 'Return' | 'Struct';
    label: string;
    rows: Row[];
    canAdd: boolean;
    returnType?: string;
  }[];
  readonly types: string[];
  readonly error?: string;
}

const SECTIONS: Record<string, SectionKind[]> = {
  FB: ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant'],
  FC: ['Input', 'Output', 'InOut', 'Temp', 'Constant'],
  OB: ['Temp', 'Constant'],
  DB: ['Static'],
};

/** The interface table of every block of the file (types, FBs, FCs, OBs and DBs alike). */
export function interfaceModels(input: ModelInput): FileModel<InterfaceModel> {
  return { blocks: blockIndexes(input, () => true).map((i) => interfaceModel(input, i)) };
}

export function interfaceModel(input: ModelInput, blockIndex = 0): InterfaceModel {
  const c = blockContext(input, blockIndex);
  if (typeof c === 'string')
    return {
      view: 'interface',
      blockIndex,
      blockName: '',
      blockKind: '',
      format: 's7dcl',
      failsafe: false,
      culture: input.culture,
      sections: [],
      types: [],
      error: c,
    };
  const sections: InterfaceModel['sections'] = [];
  if (c.block.kind === 'UDT') {
    const rows: Row[] = [];
    memberRows(c, c.block.struct?.members ?? [], [], 0, rows);
    sections.push({ kind: 'Struct', label: 'Members', rows, canAdd: true });
  } else {
    for (const kind of SECTIONS[c.block.kind] ?? []) {
      const rows: Row[] = [];
      for (const s of c.block.sections.filter((x) => x.kind === kind))
        memberRows(c, s.members, [], 0, rows);
      sections.push({ kind, label: kind, rows, canAdd: true });
    }
    if (c.block.kind === 'FC') {
      sections.push({
        kind: 'Return',
        label: 'Return',
        rows: [],
        canAdd: false,
        returnType: c.block.returnType ? c.parsed.source.slice(c.block.returnType.range) : 'Void',
      });
    }
  }
  return {
    view: 'interface',
    blockIndex,
    blockName: c.block.name.text,
    blockKind: c.block.kind,
    format: c.parsed.format,
    failsafe: c.symbol?.failsafe ?? false,
    culture: c.culture,
    sections,
    types: typeCompletions(c.project),
  };
}

// --- Data block editor -----------------------------------------------------------------------------

export interface DataBlockModel {
  readonly view: 'datablock';
  readonly blockIndex: number;
  readonly blockName: string;
  readonly dbKind: 'global' | 'instance' | 'array' | '';
  readonly instanceOf: string;
  readonly format: 's7dcl' | 'source' | 'simaticml';
  /** A SimaticML export: shown, never edited (ADR 0014). */
  readonly readOnly?: boolean;
  readonly failsafe: boolean;
  readonly culture: string;
  readonly rows: Row[];
  readonly types: string[];
  readonly note?: string;
  readonly error?: string;
}

const MAX_ELEMENTS = 100;

type Owner = { file: BlockFile; block: Block; resources: ResourceFile | undefined };

/** The data blocks of the file; a file without one gets a single model that says so. */
export function dataBlockModels(input: ModelInput): FileModel<DataBlockModel> {
  return {
    blocks: blockIndexes(input, (b) => b.kind === 'DB').map((i) => dataBlockModel(input, i)),
  };
}

export function dataBlockModel(input: ModelInput, blockIndex = 0): DataBlockModel {
  const c = blockContext(input, blockIndex);
  const empty = {
    view: 'datablock' as const,
    blockIndex,
    blockName: '',
    dbKind: '' as const,
    instanceOf: '',
    format: 's7dcl' as const,
    failsafe: false,
    culture: input.culture,
    rows: [],
    types: [],
  };
  if (typeof c === 'string') return { ...empty, error: c };
  if (c.block.kind !== 'DB')
    return {
      ...empty,
      blockName: c.block.name.text,
      error: 'This block is not a data block; use the interface editor.',
    };
  const profile = c.project.profile;
  const index = c.project.index;
  const rows: Row[] = [];
  let note: string | undefined;
  const dbKind =
    c.symbol?.dbKind ??
    (c.block.dbType === undefined
      ? 'global'
      : c.block.dbType.kind === 'array'
        ? 'array'
        : 'instance');
  const startRow = (
    pathText: string,
    path: string[],
    level: number,
    name: string,
    type: DataType,
    declared: Partial<Row>,
  ): Row => {
    const value = startValueText(c.parsed, c.block, pathText) ?? '';
    const problem = value ? validateStartValue(type, value, profile) : undefined;
    return {
      path,
      level,
      name,
      type: typeName(type),
      value,
      defaultValue: declared.defaultValue ?? '',
      retain: declared.retain ?? null,
      accessible: declared.accessible ?? true,
      visible: declared.visible ?? true,
      writable: declared.writable ?? true,
      setpoint: declared.setpoint ?? false,
      comment: declared.comment ?? '',
      start: declared.start ?? c.block.range.start,
      end: declared.end ?? c.block.range.start,
      structured: false,
      declarationEditable: declared.declarationEditable ?? false,
      problems: [...(problem ? [problem] : []), ...(declared.problems ?? [])],
    };
  };
  const walk = (
    infos: readonly MemberInfo[],
    prefix: string[],
    level: number,
    editable: boolean,
    owner: Owner | undefined,
  ) => {
    for (const info of infos) {
      const path = [...prefix, info.name];
      const pathText = path.join('.');
      const location = owner ? findMember(owner.block, path) : undefined;
      const dctx: DeclarationContext | undefined = owner
        ? { file: owner.file, block: owner.block, resources: owner.resources }
        : undefined;
      const flags = location && dctx ? memberFlags(dctx, location) : undefined;
      const declared: Partial<Row> = {
        defaultValue:
          location?.member.initial && owner
            ? owner.file.source.slice(location.member.initial.range)
            : '',
        retain: flags?.retain ?? null,
        accessible: flags?.accessible ?? true,
        visible: flags?.visible ?? true,
        writable: flags?.writable ?? true,
        setpoint: flags?.setpoint ?? false,
        comment: location && dctx ? (memberComment(dctx, location.member, c.culture) ?? '') : '',
        ...(location && editable
          ? {
              start: location.member.range.start,
              end: location.member.range.end,
              problems: problemsIn(
                c.diagnostics,
                location.member.range.start,
                location.member.range.end,
              ),
            }
          : {}),
        declarationEditable: editable,
      };
      const t = info.type;
      if (t.kind === 'struct' || t.kind === 'udt') {
        rows.push({
          ...startRow(pathText, path, level, info.name, t, declared),
          value: '',
          structured: true,
        });
        walk(
          t.kind === 'struct' ? t.members : t.members(),
          path,
          level + 1,
          editable && t.kind === 'struct',
          t.kind === 'struct' ? owner : undefined,
        );
      } else if (
        t.kind === 'array' &&
        !t.star &&
        t.dimensions.length === 1 &&
        t.dimensions[0]!.lower !== undefined &&
        t.dimensions[0]!.upper !== undefined
      ) {
        rows.push({
          ...startRow(pathText, path, level, info.name, t, declared),
          value: '',
          structured: true,
        });
        const { lower, upper } = t.dimensions[0]! as { lower: number; upper: number };
        const last = Math.min(upper, lower + MAX_ELEMENTS - 1);
        if (upper > last) note = `Arrays show their first ${MAX_ELEMENTS} elements.`;
        for (let i = lower; i <= last; i++) {
          const elementPath = [...prefix, `${info.name}[${i}]`];
          const element = t.element;
          const elementRow = startRow(
            `${pathText}[${i}]`,
            elementPath,
            level + 1,
            `[${i}]`,
            element,
            {},
          );
          if (element.kind !== 'struct' && element.kind !== 'udt') {
            rows.push(elementRow);
            continue;
          }
          // the members of each element carry the start values (Path[1].X := 10.0;, C42)
          rows.push({ ...elementRow, value: '', structured: true });
          walk(
            element.kind === 'struct' ? element.members : element.members(),
            elementPath,
            level + 2,
            false,
            undefined,
          );
        }
      } else {
        rows.push(startRow(pathText, path, level, info.name, t, declared));
      }
    }
  };
  let instanceOf = '';
  if (dbKind === 'instance') {
    const fbType = c.block.dbType
      ? index.resolveType(c.block.dbType, c.symbol?.namespace, c.symbol?.id ?? '', c.file.path)
      : undefined;
    instanceOf = c.block.dbType ? c.parsed.source.slice(c.block.dbType.range) : '';
    if (fbType?.kind === 'fb') {
      const fb = index.block(fbType.block.id);
      const fbFile = fb?.file.parsed?.kind === 'blocks' ? fb.file.parsed : undefined;
      walk(
        fbType.members(),
        [],
        0,
        false,
        fb && fbFile
          ? { file: fbFile, block: fb.block, resources: index.resourcesFor(fb.file) }
          : undefined,
      );
    } else if (fbType?.kind === 'system') {
      for (const p of fbType.type.parameters) {
        const t = profile.elementary(p.type);
        rows.push(
          startRow(
            p.name,
            [p.name],
            0,
            p.name,
            t ? { kind: 'elementary', name: t.name, info: t } : { kind: 'generic', name: p.type },
            {},
          ),
        );
      }
    } else {
      note = `The block ${instanceOf} is not in the exported files; only the existing start values are shown.`;
      for (const a of c.block.startValues) {
        const p = c.parsed.source.slice(a.target.range);
        rows.push(startRow(p, [p], 0, p, { kind: 'unknown', text: '' }, {}));
      }
    }
  } else if (dbKind === 'array') {
    // Element start values are written THIS[i] := value; in both formats (corpus C40). Elements of
    // structured types have no exported sample yet: shown, not edited.
    const t = c.block.dbType
      ? index.resolveType(c.block.dbType, c.symbol?.namespace, c.symbol?.id ?? '', c.file.path)
      : undefined;
    if (
      t?.kind === 'array' &&
      t.dimensions[0]?.lower !== undefined &&
      t.dimensions[0].upper !== undefined
    ) {
      const { lower, upper } = t.dimensions[0] as { lower: number; upper: number };
      const last = Math.min(upper, lower + MAX_ELEMENTS - 1);
      const structured = t.element.kind !== 'elementary';
      const element = t.element;
      for (let i = lower; i <= last; i++) {
        rows.push({
          ...startRow(`THIS[${i}]`, [`THIS[${i}]`], 0, `[${i}]`, element, {}),
          structured,
        });
        if (element.kind !== 'struct' && element.kind !== 'udt') continue;
        // the members of each element, shown with their start values but not edited (no TIA
        // sample of THIS[i].member := value; yet)
        const first = rows.length;
        walk(
          element.kind === 'struct' ? element.members : element.members(),
          [`THIS[${i}]`],
          1,
          false,
          undefined,
        );
        for (let r = first; r < rows.length; r++) rows[r] = { ...rows[r]!, valueEditable: false };
      }
      if (upper > last) note = `Arrays show their first ${MAX_ELEMENTS} elements.`;
      if (structured)
        note = 'Start values of structured array elements are shown read-only: edit them in TIA.';
    }
  } else if (c.symbol) {
    walk(index.dbMembers(c.symbol), [], 0, true, {
      file: c.parsed,
      block: c.block,
      resources: c.resources,
    });
  }
  return {
    view: 'datablock',
    blockIndex,
    blockName: c.block.name.text,
    dbKind,
    instanceOf,
    format: c.parsed.format,
    failsafe: c.symbol?.failsafe ?? false,
    culture: c.culture,
    rows,
    types: typeCompletions(c.project),
    ...(note ? { note } : {}),
  };
}

// --- Translation table -------------------------------------------------------------------------

export interface TranslationModel {
  readonly view: 'translations';
  readonly blockIndex: number;
  readonly blockName: string;
  readonly failsafe: boolean;
  readonly cultures: string[];
  readonly culture: string;
  readonly rows: {
    id: string;
    context: string;
    texts: Record<string, string>;
    missing: string[];
    start: number;
    end: number;
  }[];
  readonly error?: string;
}

export function translationModels(input: ModelInput): FileModel<TranslationModel> {
  // external sources have no translations: one model says so, not one per block
  const parsed = input.project.files.get(input.path)?.parsed;
  const indexes =
    parsed?.kind === 'blocks' && parsed.format === 's7dcl' ? blockIndexes(input, () => true) : [0];
  return { blocks: indexes.map((i) => translationModel(input, i)) };
}

export function translationModel(input: ModelInput, blockIndex = 0): TranslationModel {
  const c = blockContext(input, blockIndex);
  const empty = {
    view: 'translations' as const,
    blockIndex,
    blockName: '',
    failsafe: false,
    cultures: [],
    culture: input.culture,
    rows: [],
  };
  if (typeof c === 'string') return { ...empty, error: c };
  if (c.parsed.format !== 's7dcl')
    return {
      ...empty,
      blockName: c.block.name.text,
      error:
        'External sources keep one comment per member; translations live in SIMATIC SD documents (.s7res).',
    };
  const rows: TranslationModel['rows'] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined, context: string, start: number, end: number) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const texts: Record<string, string> = {};
    for (const culture of c.cultures) texts[culture] = resourceText(c.resources, id, culture) ?? '';
    const filled = Object.values(texts).some((t) => t !== '');
    rows.push({
      id,
      context,
      texts,
      missing: filled ? c.cultures.filter((x) => texts[x] === '') : [],
      start,
      end,
    });
  };
  const walk = (members: readonly Member[], prefix: string) => {
    for (const m of members) {
      add(
        m.attributes.find((a) => a.name === 'S7_MLC')?.value,
        `${prefix}${m.name.text}`,
        m.range.start,
        m.range.end,
      );
      if (m.type.kind === 'struct') walk(m.type.members, `${prefix}${m.name.text}.`);
    }
  };
  for (const s of c.block.sections) walk(s.members, '');
  if (c.block.struct) walk(c.block.struct.members, '');
  for (const n of c.block.networks) {
    add(n.titleId, `Network ${n.index} title`, n.range.start, n.range.end);
    add(n.commentId, `Network ${n.index} comment`, n.range.start, n.range.end);
  }
  for (const e of c.resources?.entries ?? [])
    add(e.id, '(not used in the block)', c.block.range.start, c.block.range.start);
  return {
    view: 'translations',
    blockIndex,
    blockName: c.block.name.text,
    failsafe: c.symbol?.failsafe ?? false,
    cultures: c.cultures,
    culture: c.culture,
    rows,
  };
}

// --- Edits ----------------------------------------------------------------------------------------

function memberSymbolId(c: BlockContext, path: readonly string[]): string {
  let id = c.symbol?.id ?? blockId(c.block.namespace, c.block.name.text);
  for (const p of path) id = memberId(id, p);
  return id;
}

/** Renames a member everywhere it is used (rename refactor); falls back to the declaration. */
function renameMember(c: BlockContext, path: readonly string[], newName: string): EditResult {
  const result = renameEdits(c.project, memberSymbolId(c, path), newName);
  if ('error' in result) {
    if (result.error !== 'Nothing to rename here.') return { edits: [], error: result.error };
    const location = findMember(c.block, path);
    if (!location) return { edits: [], error: `No member ${path.join('.')}.` };
    return {
      edits: [
        {
          start: location.member.name.range.start,
          end: location.member.name.range.end,
          newText: newName,
        },
      ],
    };
  }
  const own = result.edits.get(c.file.path) ?? [];
  const otherFiles = new Map([...result.edits].filter(([p]) => p !== c.file.path));
  return { edits: own, otherFiles };
}

/** The edits for one message of the interface or data block editor. */
export function declarationEdit(c: BlockContext, message: Message): EditResult | undefined {
  const path = Array.isArray(message['path']) ? (message['path'] as string[]) : [];
  const value = typeof message['value'] === 'string' ? message['value'] : '';
  const dctx = declContext(c);
  switch (message['op']) {
    case 'rename':
      return renameMember(c, path, value.trim());
    case 'type':
      return retypeMember(dctx, path, value);
    case 'value':
      return setDefaultValue(dctx, path, value || undefined);
    case 'start': {
      const pathText = path.join('.').replace(/\.\[/g, '[');
      const problem = value ? startValueProblem(c, path, value) : undefined;
      if (problem) return { edits: [], error: problem };
      return setStartValue(c.parsed, c.block, pathText, value || undefined);
    }
    case 'comment':
      return setMemberComment(
        dctx,
        path,
        typeof message['culture'] === 'string' ? message['culture'] : c.culture,
        value,
      );
    case 'flag':
      return setMemberFlags(dctx, path, { [String(message['flag'])]: message['value'] === true });
    case 'add':
      return addMember(
        dctx,
        String(message['section'] === 'Struct' ? 'Static' : message['section']) as SectionKind,
        {
          name: String(message['name'] ?? ''),
          type: String(message['typeText'] ?? ''),
          comment: String(message['comment'] ?? ''),
        },
        {
          culture: c.culture,
          ...(Array.isArray(message['after']) ? { after: message['after'] as string[] } : {}),
          ...(Array.isArray(message['parent']) ? { parent: message['parent'] as string[] } : {}),
        },
      );
    case 'returnType':
      return setReturnType(dctx, value);
    case 'delete':
      return deleteMember(dctx, path);
    case 'move':
      return moveMember(dctx, path, message['direction'] === -1 ? -1 : 1);
    default:
      return undefined;
  }
}

/** A start value that does not fit its member's type is refused (TIA would reject the import). */
function startValueProblem(
  c: BlockContext,
  path: readonly string[],
  value: string,
): string | undefined {
  const row = dataBlockModel(
    {
      project: c.project,
      path: c.file.path,
      cultures: c.cultures,
      culture: c.culture,
      diagnostics: [],
    },
    c.blockIndex,
  ).rows.find((r) => r.path.join('.') === path.join('.'));
  if (!row) return undefined;
  const type = typeForRow(c, row);
  return type ? validateStartValue(type, value, c.project.profile) : undefined;
}

function typeForRow(c: BlockContext, row: Row): DataType | undefined {
  const info = c.project.profile.elementary(row.type.replace(/\[\d+\]$/, ''));
  if (!info) return undefined;
  const len = /\[(\d+)\]$/.exec(row.type);
  return { kind: 'elementary', name: info.name, info, length: len ? Number(len[1]) : undefined };
}

/** The edits for one message of the translation table. */
export function translationEdit(c: BlockContext, message: Message): EditResult | undefined {
  if (message['op'] !== 'text') return undefined;
  const id = String(message['id']);
  const culture = String(message['culture']);
  const text = String(message['value'] ?? '');
  return c.resources
    ? { edits: [], resourceEdits: setResourceText(c.resources, id, culture, text) }
    : {
        edits: [],
        newResourceText: newResourceFileText(
          [{ id, values: { [culture]: text } }],
          c.parsed.source.newline,
        ),
      };
}
