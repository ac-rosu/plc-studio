// Tag table editor (spec M11): tags and user constants of a SimaticML tag table, edited in place;
// renames update every reference in code; address checks per CPU family; CSV import/export.
import * as vscode from 'vscode';
import {
  addEntry,
  addressProblems,
  csvChanges,
  deleteEntry,
  exportCsv,
  findEntry,
  nextCsvEdit,
  parseTagTableText,
  renameEdits,
  renameEntryText,
  setConstantValue,
  setEntryAddress,
  setEntryComment,
  setEntryDataType,
  setEntryFlag,
  type EditResult,
  type TagFlag,
  type TagTableFile,
} from '@plcstudio/core';
import { registerTextEditorView, type ViewContext } from '../webview/text-editor-view.ts';
import type { FeatureContext } from './index.ts';
import { applyResult } from './tables.ts';
import { workspaceModel } from './tables-workspace.ts';

export const TAG_TABLE_EDITOR = 'plcstudio.tagTableEditor';
export const TAG_TABLE_EDITOR_ANY = 'plcstudio.tagTableEditorAny';

export interface TagRow {
  readonly kind: 'tag' | 'constant' | 'systemConstant';
  readonly name: string;
  readonly dataType: string;
  readonly address: string;
  readonly value: string;
  readonly accessible: boolean;
  readonly visible: boolean;
  readonly writable: boolean;
  readonly comments: Record<string, string>;
  readonly problems: { severity: string; message: string }[];
  readonly start: number;
  readonly end: number;
}

export interface TagTableModel {
  readonly view: 'tagtable';
  readonly name: string;
  readonly family: string;
  readonly cultures: string[];
  readonly culture: string;
  readonly rows: TagRow[];
  readonly error?: string;
}

export function tagTableModel(
  document: vscode.TextDocument,
  extension: vscode.ExtensionContext,
): TagTableModel {
  const ws = workspaceModel(extension);
  const table = parseTagTableText(document.getText());
  if (table.diagnostics.length > 0 && table.entries.length === 0 && !table.name) {
    return {
      view: 'tagtable',
      name: '',
      family: '',
      cultures: [],
      culture: 'en-US',
      rows: [],
      error: 'This XML file is not a PLC tag table.',
    };
  }
  const project = ws.projectFor(document);
  const path = ws.pathOf(document.uri);
  const others = [...project.files.values()]
    .filter((f) => f.path !== path && f.parsed?.kind === 'tagTable')
    .map((f) => f.parsed as TagTableFile);
  const family = project.cpuFamily;
  const problems = addressProblems([table, ...others], family).filter((p) =>
    table.entries.includes(p.entry),
  );
  const cultures = [
    ...new Set([...ws.cultures(project), ...table.entries.flatMap((e) => [...e.comments.keys()])]),
  ].sort();
  const culture = ws.displayLanguage(project, cultures);
  if (!cultures.includes(culture)) cultures.push(culture);
  return {
    view: 'tagtable',
    name: table.name,
    family: family ?? '',
    cultures: cultures.sort(),
    culture,
    rows: table.entries.map((e) => ({
      kind: e.kind,
      name: e.name,
      dataType: e.dataType,
      address: e.address ?? '',
      value: e.value ?? '',
      accessible: e.accessible,
      visible: e.visible,
      writable: e.writable,
      comments: Object.fromEntries([...e.comments].map(([c, t]) => [c, t.text])),
      problems: problems
        .filter((p) => p.entry === e)
        .map((p) => ({ severity: p.severity, message: p.message })),
      start: e.range.start,
      end: e.range.end,
    })),
  };
}

type Message = { type: string; [key: string]: unknown };

async function handle(
  message: Message,
  view: ViewContext,
  extension: vscode.ExtensionContext,
): Promise<void> {
  const ws = workspaceModel(extension);
  const document = view.document;
  const table = parseTagTableText(document.getText());
  const name = String(message['name'] ?? '');
  const value = typeof message['value'] === 'string' ? message['value'] : '';
  const entry = findEntry(table, name);
  let result: EditResult | undefined;
  switch (message['op']) {
    case 'rename': {
      if (!entry) return;
      const project = ws.projectFor(document);
      const id = `${entry.kind === 'tag' ? 'tag' : 'constant'}:${entry.name.toLowerCase()}`;
      const renamed = renameEdits(project, id, value.trim());
      if ('error' in renamed) {
        result =
          renamed.error === 'Nothing to rename here.'
            ? { edits: renameEntryText(table, entry, value.trim()) }
            : { edits: [], error: renamed.error };
      } else {
        const own =
          renamed.edits.get(ws.pathOf(document.uri)) ?? renameEntryText(table, entry, value.trim());
        result = {
          edits: own,
          otherFiles: new Map([...renamed.edits].filter(([p]) => p !== ws.pathOf(document.uri))),
        };
      }
      break;
    }
    case 'type':
      if (entry) result = setEntryDataType(table, entry, value);
      break;
    case 'address':
      if (entry) result = setEntryAddress(table, entry, value);
      break;
    case 'value':
      if (entry) result = setConstantValue(table, entry, value);
      break;
    case 'flag':
      if (entry)
        result = setEntryFlag(
          table,
          entry,
          String(message['flag']) as TagFlag,
          message['value'] === true,
        );
      break;
    case 'comment':
      if (entry) result = setEntryComment(table, entry, String(message['culture']), value);
      break;
    case 'add':
      result = addEntry(table, {
        kind: message['kind'] === 'constant' ? 'constant' : 'tag',
        name: String(message['newName'] ?? '').trim(),
        dataType: String(message['dataType'] ?? 'Bool').trim() || 'Bool',
        addressOrValue: String(message['addressOrValue'] ?? '').trim(),
      });
      break;
    case 'delete':
      if (entry) result = deleteEntry(table, entry);
      break;
    case 'exportCsv':
      await exportTable(document, table);
      return;
    case 'importCsv':
      await importTable(document, view);
      return;
    default:
      return;
  }
  if (!result) return;
  const problem = await applyResult(document, result, ws);
  if (problem) void view.webview.postMessage({ type: 'problem', message: problem });
}

async function exportTable(document: vscode.TextDocument, table: TagTableFile): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: document.uri.with({ path: document.uri.path.replace(/\.xml$/i, '.csv') }),
    filters: { CSV: ['csv'] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(exportCsv(table)));
  void vscode.window.showInformationMessage(
    `PLC Studio: exported ${table.entries.length} tags and constants.`,
  );
}

/** Applies a CSV one change at a time, re-reading the table between steps (minimal edits). */
async function importTable(document: vscode.TextDocument, view: ViewContext): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { CSV: ['csv'] },
  });
  if (!picked?.[0]) return;
  const csv = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(picked[0]));
  const first = csvChanges(parseTagTableText(document.getText()), csv);
  if (first.problems.length > 0)
    void vscode.window.showWarningMessage(`PLC Studio: ${first.problems.slice(0, 3).join(' ')}`);
  let applied = 0;
  for (let guard = 0; guard < 5000; guard++) {
    const table = parseTagTableText(document.getText());
    const { changes } = csvChanges(table, csv);
    let next: EditResult | undefined;
    for (const c of changes) {
      next = nextCsvEdit(table, c);
      if (next) break;
    }
    if (!next) break;
    if (next.error) {
      void vscode.window.showWarningMessage(`PLC Studio: ${next.error}`);
      break;
    }
    if (!(await view.applyEdits(next.edits))) break;
    applied++;
  }
  void vscode.window.showInformationMessage(
    `PLC Studio: CSV import made ${applied} change${applied === 1 ? '' : 's'}.`,
  );
}

export function registerTagTable({ extension }: FeatureContext): void {
  const options = {
    view: 'tagtable',
    title: (d: vscode.TextDocument) => `Tags ${d.uri.path.slice(d.uri.path.lastIndexOf('/') + 1)}`,
    model: tagTableModel,
    onMessage: (m: Message, v: ViewContext) => handle(m, v, extension),
  };
  extension.subscriptions.push(
    registerTextEditorView(extension, { ...options, viewType: TAG_TABLE_EDITOR }),
    registerTextEditorView(extension, { ...options, viewType: TAG_TABLE_EDITOR_ANY }),
    vscode.commands.registerCommand('plcstudio.openTagTableEditor', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target)
        await vscode.commands.executeCommand('vscode.openWith', target, TAG_TABLE_EDITOR_ANY);
    }),
  );
}
