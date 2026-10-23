// LAD/FBD view and editor (spec M8, M10): a custom editor over the .s7dcl text. The model is
// built with core in the extension host; edits are computed with core/ladder/edit.ts and applied
// as one WorkspaceEdit, so undo/redo is VS Code's and an open text editor updates live.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  addNetwork,
  addParallelBranch,
  connectPin,
  copyNetwork,
  deleteBranch,
  deleteElement,
  deleteNetwork,
  duplicateNetwork,
  insertElement,
  ladderBlockView,
  moveElement,
  moveNetwork,
  paletteElement,
  parseBlockText,
  parseResources,
  pasteNetwork,
  setNetworkText,
  setOperand,
  SourceText,
  type LadderEditOutcome,
  type LadderElement,
  type NetworkClipboard,
  type ResourceFile,
} from '@plcstudio/core';
import { profileIndex } from '@plcstudio/profiles';
import type {
  CompletionEntry,
  EditIntent,
  LadderModel,
  PaletteItem,
  ViewMessage,
} from '@plcstudio/webviews/ladder/protocol';
import {
  diagnosticsFor,
  registerTextEditorView,
  type ViewContext,
} from '../webview/text-editor-view.ts';
import type { FeatureContext } from './index.ts';

export const LADDER_VIEW_TYPE = 'plcstudio.ladderEditor';

/** Copied network, shared by every LAD/FBD view of the window. */
let clipboard: NetworkClipboard | undefined;

const profile = () => profileIndex('V21')!;

function resourcesUri(document: vscode.TextDocument): vscode.Uri {
  return document.uri.with({ path: document.uri.path.replace(/\.s7dcl$/i, '.s7res') });
}

function readResources(document: vscode.TextDocument): ResourceFile | undefined {
  const uri = resourcesUri(document);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  let text: string | undefined = open?.getText();
  if (text === undefined && uri.scheme === 'file') {
    try {
      // offsets of the parsed .s7res do not count a BOM
      text = SourceText.fromBytes(fs.readFileSync(uri.fsPath)).text;
    } catch {
      text = undefined;
    }
  }
  return text === undefined ? undefined : parseResources(new SourceText(text));
}

/** Display language: user setting, else plc.json of the PLC folder. */
function displayLanguage(document: vscode.TextDocument): string | undefined {
  const setting = vscode.workspace.getConfiguration('plcstudio').get<string>('displayLanguage');
  if (setting) return setting;
  if (document.uri.scheme !== 'file') return undefined;
  let dir = path.dirname(document.uri.fsPath);
  for (let i = 0; i < 12; i++) {
    const manifest = path.join(dir, 'plc.json');
    try {
      const json = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { displayLanguage?: unknown };
      return typeof json.displayLanguage === 'string' ? json.displayLanguage : undefined;
    } catch {
      // not here
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function buildModel(document: vscode.TextDocument): LadderModel {
  const file = parseBlockText(document.getText(), 's7dcl');
  const block = file.blocks.find((b) => b.kind === 'FB' || b.kind === 'FC' || b.kind === 'OB');
  // the FB of a multi-instance call, from the block's own interface
  const describeCall = (element: LadderElement) => {
    if (element.callee.kind !== 'local' || !block) return undefined;
    const name = element.callee.name.text.toLowerCase();
    const member = block.sections
      .flatMap((s) => s.members)
      .find((m) => m.name.text.toLowerCase() === name);
    if (member?.type.kind !== 'named') return undefined;
    return { title: member.type.path.map((p) => p.text).join('.') };
  };
  const view = ladderBlockView(file, {
    profile: profile(),
    resources: readResources(document),
    displayLanguage: displayLanguage(document),
    describeCall,
  });
  const editable = vscode.workspace
    .getConfiguration('plcstudio')
    .get<boolean>('ladder.editing', true);
  const palette: PaletteItem[] = profile()
    .profile.ladderElements.filter((e) => !view?.failsafe || e.failsafeAllowed !== false)
    .map((e) => ({
      name: e.name,
      shape: e.shape,
      symbol: e.symbol ?? e.name,
      description: e.description ?? e.name,
      languages: e.languages,
    }));
  return {
    fileName: path.basename(document.uri.path),
    view,
    diagnostics: diagnosticsFor(document),
    palette,
    editable,
    message: view
      ? undefined
      : 'This file has no OB, FB or FC with networks to draw (data blocks and types are shown as text).',
  };
}

async function applyResult(
  view: ViewContext,
  result: LadderEditOutcome,
  label: string,
): Promise<void> {
  if ('error' in result) {
    void view.webview.postMessage({ type: 'error', message: result.error });
    return;
  }
  const document = view.document;
  const edit = new vscode.WorkspaceEdit();
  for (const e of result.edits)
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)),
      e.newText,
    );
  const resUri = resourcesUri(document);
  if (result.resourceEdits?.length) {
    const resDoc = await vscode.workspace.openTextDocument(resUri);
    for (const e of result.resourceEdits)
      edit.replace(
        resUri,
        new vscode.Range(resDoc.positionAt(e.start), resDoc.positionAt(e.end)),
        e.newText,
      );
  }
  if (result.resourceCreate) {
    edit.createFile(resUri, { ignoreIfExists: true });
    edit.insert(resUri, new vscode.Position(0, 0), result.resourceCreate);
  }
  if (result.edits.length || result.resourceEdits?.length || result.resourceCreate) {
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      void view.webview.postMessage({ type: 'error', message: `${label} could not be applied.` });
      return;
    }
  }
  if (result.clipboard) {
    clipboard = result.clipboard;
    await vscode.env.clipboard.writeText(result.clipboard.text);
    void view.webview.postMessage({ type: 'error', message: 'Network copied.' });
  }
  if (result.missingDeclarations?.length) {
    void vscode.window.showInformationMessage(
      `PLC Studio: the pasted network uses ${result.missingDeclarations.map((n) => '#' + n).join(', ')}, which this block does not declare yet.`,
    );
  }
  if (result.select) void view.webview.postMessage({ type: 'select', ...result.select });
}

function runIntent(document: vscode.TextDocument, intent: EditIntent): LadderEditOutcome {
  const text = document.getText();
  const resources = readResources(document);
  const view = parseBlockText(text, 's7dcl');
  const language =
    view.blocks[0]?.networks.find((n) => n.ladder)?.language === 'FBD' ? 'FBD' : 'LAD';
  switch (intent.op) {
    case 'setOperand':
      return setOperand(text, intent.start, intent.end, intent.expected, intent.text);
    case 'connectPin':
      return connectPin(text, intent.ref, intent.pin, intent.direction, intent.text);
    case 'insert': {
      const element = paletteElement(profile(), intent.element, language);
      return element
        ? insertElement(text, intent.ref, element)
        : { error: `${intent.element} is not in the palette.` };
    }
    case 'delete':
      return deleteElement(text, intent.ref);
    case 'move':
      return moveElement(text, intent.ref, intent.direction);
    case 'addBranch':
      return addParallelBranch(text, intent.ref, intent.to);
    case 'deleteBranch':
      return deleteBranch(text, intent.network, intent.rung);
    case 'addNetwork':
      return addNetwork(text, intent.after, intent.language);
    case 'deleteNetwork':
      return deleteNetwork(text, intent.network);
    case 'moveNetwork':
      return moveNetwork(text, intent.network, intent.direction);
    case 'duplicateNetwork':
      return duplicateNetwork(text, intent.network, resources);
    case 'copyNetwork':
      return copyNetwork(text, intent.network, resources);
    case 'pasteNetwork':
      return clipboard
        ? pasteNetwork(text, intent.after, clipboard, resources)
        : { error: 'Copy a network first.' };
    case 'setText': {
      const culture =
        displayLanguage(document) ?? resources?.entries[0]?.values[0]?.culture ?? 'en-US';
      return setNetworkText(text, intent.network, intent.role, culture, intent.text, resources);
    }
  }
}

function hoverText(hovers: readonly vscode.Hover[] | undefined): string {
  const parts: string[] = [];
  for (const hover of hovers ?? []) {
    for (const c of hover.contents) {
      const value = typeof c === 'string' ? c : 'value' in c ? c.value : '';
      if (value)
        parts.push(
          value
            .replace(/```\w*\n?/g, '')
            .replace(/\*\*/g, '')
            .trim(),
        );
    }
  }
  return parts.join('\n\n');
}

async function onMessage(message: ViewMessage, view: ViewContext): Promise<void> {
  const document = view.document;
  switch (message.type) {
    case 'hover': {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        document.positionAt(message.offset + 1),
      );
      void view.webview.postMessage({
        type: 'hoverResult',
        id: message.id,
        text: hoverText(hovers),
      });
      return;
    }
    case 'definition': {
      const result = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >('vscode.executeDefinitionProvider', document.uri, document.positionAt(message.offset + 1));
      const first = result?.[0];
      if (!first) {
        void view.webview.postMessage({ type: 'error', message: 'No definition found.' });
        return;
      }
      const uri = 'targetUri' in first ? first.targetUri : first.uri;
      const range =
        'targetUri' in first ? (first.targetSelectionRange ?? first.targetRange) : first.range;
      await vscode.window.showTextDocument(uri, {
        selection: range,
        viewColumn: vscode.ViewColumn.Beside,
        preview: true,
      });
      return;
    }
    case 'complete': {
      const text = document.getText();
      const first = text[message.offset];
      const at = first === '#' || first === '"' ? message.offset + 1 : message.offset;
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        document.positionAt(at),
      );
      const items: CompletionEntry[] = (list?.items ?? []).slice(0, 200).map((c) => {
        const label = typeof c.label === 'string' ? c.label : c.label.label;
        const insert =
          typeof c.insertText === 'string' ? c.insertText : (c.insertText?.value ?? label);
        const prefix =
          first === '#' && !insert.startsWith('#')
            ? '#'
            : first === '"' && !insert.startsWith('"')
              ? '"'
              : '';
        const suffix = prefix === '"' && !insert.endsWith('"') ? '"' : '';
        return { label, detail: c.detail, insertText: prefix + insert + suffix };
      });
      void view.webview.postMessage({ type: 'completionResult', id: message.id, items });
      return;
    }
    case 'edit': {
      if (message.version !== document.version) {
        view.refresh();
        void view.webview.postMessage({
          type: 'error',
          message: 'The text changed meanwhile; the view is updated, try again.',
        });
        return;
      }
      await applyResult(view, runIntent(document, message.intent), message.intent.op);
      return;
    }
    default:
      return;
  }
}

export function registerLadderEditor(context: FeatureContext): void {
  const extension = context.extension;
  extension.subscriptions.push(
    registerTextEditorView<LadderModel>(extension, {
      viewType: LADDER_VIEW_TYPE,
      view: 'ladder',
      title: (document) => `LAD/FBD: ${path.basename(document.uri.path)}`,
      model: (document) => buildModel(document),
      onMessage: (message, view) => onMessage(message as unknown as ViewMessage, view),
    }),
    vscode.commands.registerCommand('plcstudio.openLadderView', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showInformationMessage('PLC Studio: open a .s7dcl file first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, LADDER_VIEW_TYPE);
    }),
  );
}
