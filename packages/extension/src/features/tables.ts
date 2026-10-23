// Table editors over block files (spec M7): block interface editor, data block editor and
// translation table. The models and edits come from tables-model.ts; this module connects them to
// VS Code. Every edit is applied as one WorkspaceEdit (one undo step), the .s7res included.
import * as vscode from 'vscode';
import type { EditResult } from '@plcstudio/core';
import {
  diagnosticsFor,
  registerTextEditorView,
  type ViewContext,
} from '../webview/text-editor-view.ts';
import type { FeatureContext } from './index.ts';
import { addFileEdits, workspaceModel, type PlcWorkspaceModel } from './tables-workspace.ts';
import {
  blockContext,
  dataBlockModel,
  declarationEdit,
  interfaceModel,
  translationEdit,
  translationModel,
  type Message,
  type ModelInput,
} from './tables-model.ts';

export const INTERFACE_EDITOR = 'plcstudio.interfaceEditor';
export const DATA_BLOCK_EDITOR = 'plcstudio.dataBlockEditor';
export const TRANSLATION_TABLE = 'plcstudio.translationTable';

/** The model input for a document: its project, languages and diagnostics. */
export function modelInput(
  document: vscode.TextDocument,
  extension: vscode.ExtensionContext,
): ModelInput {
  const ws = workspaceModel(extension);
  const project = ws.projectFor(document);
  const cultures = ws.cultures(project);
  return {
    project,
    path: ws.pathOf(document.uri),
    cultures,
    culture: ws.displayLanguage(project, cultures),
    diagnostics: diagnosticsFor(document),
  };
}

function resourceUri(document: vscode.TextDocument): vscode.Uri {
  return document.uri.with({ path: document.uri.path.replace(/\.[^./]+$/, '.s7res') });
}

/** Applies an edit result: the document, its .s7res (or a new one) and other files, in one step. */
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

async function handle(
  message: Message,
  view: ViewContext,
  extension: vscode.ExtensionContext,
  compute: typeof declarationEdit,
): Promise<void> {
  const c = blockContext(modelInput(view.document, extension));
  if (typeof c === 'string') return void vscode.window.showErrorMessage(`PLC Studio: ${c}`);
  const result = compute(c, message);
  if (!result) return;
  const problem = await applyResult(view.document, result, workspaceModel(extension));
  if (problem) void view.webview.postMessage({ type: 'problem', message: problem });
}

export function registerTables({ extension }: FeatureContext): void {
  workspaceModel(extension);
  extension.subscriptions.push(
    registerTextEditorView(extension, {
      viewType: INTERFACE_EDITOR,
      view: 'interface',
      title: (d) => `Interface ${baseName(d)}`,
      model: (d) => interfaceModel(modelInput(d, extension)),
      onMessage: (m, v) => handle(m, v, extension, declarationEdit),
    }),
    registerTextEditorView(extension, {
      viewType: DATA_BLOCK_EDITOR,
      view: 'datablock',
      title: (d) => `Data block ${baseName(d)}`,
      model: (d) => dataBlockModel(modelInput(d, extension)),
      onMessage: (m, v) => handle(m, v, extension, declarationEdit),
    }),
    registerTextEditorView(extension, {
      viewType: TRANSLATION_TABLE,
      view: 'translations',
      title: (d) => `Translations ${baseName(d)}`,
      model: (d) => translationModel(modelInput(d, extension)),
      onMessage: (m, v) => handle(m, v, extension, translationEdit),
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
