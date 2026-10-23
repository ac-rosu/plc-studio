// Table editors over block files (spec M7): block interface editor, data block editor and
// translation table. Models are built with core in the extension host; every edit becomes core
// text edits applied as one WorkspaceEdit (one undo step), the .s7res included.
import * as vscode from 'vscode';
import {
  addMember,
  blockId,
  deleteMember,
  findMember,
  memberComment,
  memberFlags,
  memberId,
  moveMember,
  renameEdits,
  resourceText,
  retypeMember,
  setDefaultValue,
  setMemberComment,
  setMemberFlags,
  setResourceText,
  newResourceFileText,
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
import {
  diagnosticsFor,
  registerTextEditorView,
  type ViewContext,
} from '../webview/text-editor-view.ts';
import type { FeatureContext } from './index.ts';
import { addFileEdits, workspaceModel, type PlcWorkspaceModel } from './tables-workspace.ts';

export const INTERFACE_EDITOR = 'plcstudio.interfaceEditor';
export const DATA_BLOCK_EDITOR = 'plcstudio.dataBlockEditor';
export const TRANSLATION_TABLE = 'plcstudio.translationTable';

type Message = { type: string; [key: string]: unknown };

// --- Shared model parts ------------------------------------------------------------------------

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
  readonly problems: string[];
}

interface BlockContext {
  readonly ws: PlcWorkspaceModel;
  readonly project: Project;
  readonly file: ProjectFile;
  readonly parsed: BlockFile;
  readonly block: Block;
  readonly symbol: BlockSymbol | undefined;
  readonly resources: ResourceFile | undefined;
  readonly culture: string;
  readonly cultures: string[];
}

function blockContext(
  document: vscode.TextDocument,
  extension: vscode.ExtensionContext,
): BlockContext | string {
  const ws = workspaceModel(extension);
  const project = ws.projectFor(document);
  const path = ws.pathOf(document.uri);
  const file = project.files.get(path);
  if (!file?.parsed || file.parsed.kind !== 'blocks')
    return 'This file is not a block that PLC Studio can read.';
  const block = file.parsed.blocks[0];
  if (!block) return 'The file contains no block.';
  const symbol = project.index.blocks.find((b) => b.file.path === path && b.block === block);
  const resources = project.index.resourcesFor(file);
  const cultures = ws.cultures(project);
  const culture = ws.displayLanguage(project, cultures);
  if (!cultures.includes(culture)) cultures.push(culture);
  return {
    ws,
    project,
    file,
    parsed: file.parsed,
    block,
    symbol,
    resources,
    culture,
    cultures: cultures.sort(),
  };
}

const declContext = (c: BlockContext): DeclarationContext => ({
  file: c.parsed,
  block: c.block,
  resources: c.resources,
});

function typeText(c: BlockContext, m: Member): string {
  return m.type.kind === 'struct' ? 'Struct' : c.parsed.source.slice(m.type.range);
}

function typeCompletions(project: Project): string[] {
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

function failsafeOf(c: BlockContext): boolean {
  return c.symbol?.failsafe ?? false;
}

function problemsIn(
  diagnostics: ReturnType<typeof diagnosticsFor>,
  start: number,
  end: number,
): string[] {
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
  diagnostics: ReturnType<typeof diagnosticsFor>,
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
      problems: problemsIn(diagnostics, m.range.start, m.range.end),
    });
    if (m.type.kind === 'struct') memberRows(c, m.type.members, path, level + 1, diagnostics, out);
  }
}

// --- Interface editor ----------------------------------------------------------------------------

export interface InterfaceModel {
  readonly view: 'interface';
  readonly blockName: string;
  readonly blockKind: string;
  readonly format: 's7dcl' | 'source';
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

const SECTION_LABELS: Record<SectionKind, string> = {
  Input: 'Input',
  Output: 'Output',
  InOut: 'InOut',
  Static: 'Static',
  Temp: 'Temp',
  Constant: 'Constant',
};

function sectionsFor(kind: string): SectionKind[] {
  switch (kind) {
    case 'FB':
      return ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant'];
    case 'FC':
      return ['Input', 'Output', 'InOut', 'Temp', 'Constant'];
    case 'OB':
      return ['Temp', 'Constant'];
    case 'DB':
      return ['Static'];
    default:
      return [];
  }
}

export function interfaceModel(
  document: vscode.TextDocument,
  extension: vscode.ExtensionContext,
): InterfaceModel {
  const c = blockContext(document, extension);
  if (typeof c === 'string')
    return {
      view: 'interface',
      blockName: '',
      blockKind: '',
      format: 's7dcl',
      failsafe: false,
      culture: 'en-US',
      sections: [],
      types: [],
      error: c,
    };
  const diagnostics = diagnosticsFor(document);
  const sections: InterfaceModel['sections'] = [];
  if (c.block.kind === 'UDT') {
    const rows: Row[] = [];
    memberRows(c, c.block.struct?.members ?? [], [], 0, diagnostics, rows);
    sections.push({ kind: 'Struct', label: 'Members', rows, canAdd: true });
  } else {
    for (const kind of sectionsFor(c.block.kind)) {
      const rows: Row[] = [];
      for (const s of c.block.sections.filter((x) => x.kind === kind))
        memberRows(c, s.members, [], 0, diagnostics, rows);
      sections.push({ kind, label: SECTION_LABELS[kind], rows, canAdd: true });
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
    blockName: c.block.name.text,
    blockKind: c.block.kind,
    format: c.parsed.format,
    failsafe: failsafeOf(c),
    culture: c.culture,
    sections,
    types: typeCompletions(c.project),
  };
}

// --- Data block editor -----------------------------------------------------------------------------

export interface DataBlockModel {
  readonly view: 'datablock';
  readonly blockName: string;
  readonly dbKind: 'global' | 'instance' | 'array' | '';
  readonly instanceOf: string;
  readonly format: 's7dcl' | 'source';
  readonly failsafe: boolean;
  readonly culture: string;
  readonly rows: Row[];
  readonly types: string[];
  readonly note?: string;
  readonly error?: string;
}

const MAX_ELEMENTS = 100;

export function dataBlockModel(
  document: vscode.TextDocument,
  extension: vscode.ExtensionContext,
): DataBlockModel {
  const c = blockContext(document, extension);
  const empty = {
    view: 'datablock' as const,
    blockName: '',
    dbKind: '' as const,
    instanceOf: '',
    format: 's7dcl' as const,
    failsafe: false,
    culture: 'en-US',
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
  const diagnostics = diagnosticsFor(document);
  const profile = c.project.profile;
  const rows: Row[] = [];
  let note: string | undefined;
  const index = c.project.index;
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
    owner: { file: BlockFile; block: Block; resources: ResourceFile | undefined } | undefined,
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
                diagnostics,
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
          owner,
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
          rows.push(
            startRow(
              `${pathText}[${i}]`,
              [...prefix, `${info.name}[${i}]`],
              level + 1,
              `[${i}]`,
              t.element,
              {},
            ),
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
    // No exported sample shows how TIA writes start values of array DBs: shown, not edited.
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
      for (let i = lower; i <= last; i++)
        rows.push({
          ...startRow(`[${i}]`, [`[${i}]`], 0, `[${i}]`, t.element, {}),
          structured: true,
        });
    }
    note =
      'Array data blocks are shown read-only: start values of their elements are edited in TIA.';
  } else if (c.symbol) {
    walk(index.dbMembers(c.symbol), [], 0, true, {
      file: c.parsed,
      block: c.block,
      resources: c.resources,
    });
  }
  return {
    view: 'datablock',
    blockName: c.block.name.text,
    dbKind,
    instanceOf,
    format: c.parsed.format,
    failsafe: failsafeOf(c),
    culture: c.culture,
    rows,
    types: typeCompletions(c.project),
    ...(note ? { note } : {}),
  };
}

// --- Translation table -------------------------------------------------------------------------

export interface TranslationModel {
  readonly view: 'translations';
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

export function translationModel(
  document: vscode.TextDocument,
  extension: vscode.ExtensionContext,
): TranslationModel {
  const c = blockContext(document, extension);
  const empty = {
    view: 'translations' as const,
    blockName: '',
    failsafe: false,
    cultures: [],
    culture: 'en-US',
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
    blockName: c.block.name.text,
    failsafe: failsafeOf(c),
    cultures: c.cultures,
    culture: c.culture,
    rows,
  };
}

// --- Applying edits ------------------------------------------------------------------------------

function resourceUri(document: vscode.TextDocument): vscode.Uri {
  return document.uri.with({ path: document.uri.path.replace(/\.[^./]+$/, '.s7res') });
}

export async function applyResult(
  document: vscode.TextDocument,
  result: EditResult,
  ws: PlcWorkspaceModel,
): Promise<string | undefined> {
  if (result.error) return result.error;
  const edit = new vscode.WorkspaceEdit();
  for (const e of result.edits)
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)),
      e.newText,
    );
  if (result.resourceEdits && result.resourceEdits.length > 0)
    await addFileEdits(edit, resourceUri(document), result.resourceEdits);
  if (result.newResourceText !== undefined) {
    const uri = resourceUri(document);
    edit.createFile(uri, { ignoreIfExists: true });
    edit.insert(uri, new vscode.Position(0, 0), result.newResourceText);
  }
  for (const [path, edits] of result.otherFiles ?? [])
    await addFileEdits(edit, ws.uriOf(path), edits);
  const ok = await vscode.workspace.applyEdit(edit);
  return ok ? undefined : 'VS Code did not apply the change.';
}

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

async function handleDeclarationEdit(
  message: Message,
  view: ViewContext,
  extension: vscode.ExtensionContext,
): Promise<void> {
  const c = blockContext(view.document, extension);
  if (typeof c === 'string') return void vscode.window.showErrorMessage(`PLC Studio: ${c}`);
  const path = Array.isArray(message['path']) ? (message['path'] as string[]) : [];
  const value = typeof message['value'] === 'string' ? message['value'] : '';
  const dctx = declContext(c);
  let result: EditResult;
  switch (message['op']) {
    case 'rename':
      result = renameMember(c, path, value.trim());
      break;
    case 'type':
      result = retypeMember(dctx, path, value);
      break;
    case 'value':
      result = setDefaultValue(dctx, path, value || undefined);
      break;
    case 'start': {
      const pathText = path.join('.').replace(/\.\[/g, '[');
      result = setStartValue(c.parsed, c.block, pathText, value || undefined);
      break;
    }
    case 'comment':
      result = setMemberComment(
        dctx,
        path,
        typeof message['culture'] === 'string' ? message['culture'] : c.culture,
        value,
      );
      break;
    case 'flag':
      result = setMemberFlags(dctx, path, { [String(message['flag'])]: message['value'] === true });
      break;
    case 'add':
      result = addMember(
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
        },
      );
      break;
    case 'delete':
      result = deleteMember(dctx, path);
      break;
    case 'move':
      result = moveMember(dctx, path, message['direction'] === -1 ? -1 : 1);
      break;
    default:
      return;
  }
  const problem = await applyResult(view.document, result, c.ws);
  if (problem) void view.webview.postMessage({ type: 'problem', message: problem });
}

async function handleTranslationEdit(
  message: Message,
  view: ViewContext,
  extension: vscode.ExtensionContext,
): Promise<void> {
  if (message['op'] !== 'text') return;
  const c = blockContext(view.document, extension);
  if (typeof c === 'string') return;
  const id = String(message['id']);
  const culture = String(message['culture']);
  const text = String(message['value'] ?? '');
  const result: EditResult = c.resources
    ? { edits: [], resourceEdits: setResourceText(c.resources, id, culture, text) }
    : {
        edits: [],
        newResourceText: newResourceFileText(
          [{ id, values: { [culture]: text } }],
          c.parsed.source.newline,
        ),
      };
  const problem = await applyResult(view.document, result, c.ws);
  if (problem) void view.webview.postMessage({ type: 'problem', message: problem });
}

// --- Registration ---------------------------------------------------------------------------------

export function registerTables({ extension }: FeatureContext): void {
  workspaceModel(extension);
  extension.subscriptions.push(
    registerTextEditorView(extension, {
      viewType: INTERFACE_EDITOR,
      view: 'interface',
      title: (d) => `Interface ${baseName(d)}`,
      model: interfaceModel,
      onMessage: (m, v) => handleDeclarationEdit(m, v, extension),
    }),
    registerTextEditorView(extension, {
      viewType: DATA_BLOCK_EDITOR,
      view: 'datablock',
      title: (d) => `Data block ${baseName(d)}`,
      model: dataBlockModel,
      onMessage: (m, v) => handleDeclarationEdit(m, v, extension),
    }),
    registerTextEditorView(extension, {
      viewType: TRANSLATION_TABLE,
      view: 'translations',
      title: (d) => `Translations ${baseName(d)}`,
      model: translationModel,
      onMessage: (m, v) => handleTranslationEdit(m, v, extension),
    }),
    vscode.commands.registerCommand('plcstudio.openInterfaceEditor', (uri?: vscode.Uri) =>
      openWith(uri, INTERFACE_EDITOR),
    ),
    vscode.commands.registerCommand('plcstudio.openDataBlockEditor', (uri?: vscode.Uri) =>
      openWith(uri, DATA_BLOCK_EDITOR),
    ),
    vscode.commands.registerCommand('plcstudio.openTranslationTable', (uri?: vscode.Uri) =>
      openWith(uri, TRANSLATION_TABLE),
    ),
  );
}

function baseName(d: vscode.TextDocument): string {
  return d.uri.path.slice(d.uri.path.lastIndexOf('/') + 1);
}

export async function openWith(uri: vscode.Uri | undefined, viewType: string): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    void vscode.window.showInformationMessage('PLC Studio: open a PLC file first.');
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.openWith',
    target,
    viewType,
    vscode.ViewColumn.Beside,
  );
}
