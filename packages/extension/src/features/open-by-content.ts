// Opening by content (owner, 2026-10-24): the default editor of .s7dcl, .db and .udt files looks at
// what the file holds and hands its tab to the view that fits (open-by-content-model.ts). SCL
// blocks and mixed files go to the text editor, where every code feature works. Jumps to a place
// (definition, references, problems, call tree) open the text as before; "Reopen Editor With"
// still offers every view.
import * as vscode from 'vscode';
import { parseBlockText } from '@plcstudio/core';
import { textEditorViewProvider } from '../webview/text-editor-view.ts';
import type { FeatureContext } from './index.ts';
import { LADDER_VIEW_TYPE } from './ladder-editor.ts';
import { viewForContent, type ContentView } from './open-by-content-model.ts';
import { DATA_BLOCK_EDITOR, INTERFACE_EDITOR } from './tables.ts';
import { openXmlScl, registerXmlViews, xmlBlock, xmlView } from './xml-views.ts';

export const MATCHING_VIEW = 'plcstudio.matchingView';

const VIEW_TYPES: Record<Exclude<ContentView, 'text'>, string> = {
  ladder: LADDER_VIEW_TYPE,
  datablock: DATA_BLOCK_EDITOR,
  interface: INTERFACE_EDITOR,
};

function contentView(document: vscode.TextDocument): ContentView {
  if (!openByContent()) return 'text';
  const format = /\.s7dcl$/i.test(document.uri.path) ? 's7dcl' : 'source';
  try {
    return viewForContent(parseBlockText(document.getText(), format));
  } catch {
    return 'text';
  }
}

const openByContent = () =>
  vscode.workspace.getConfiguration('plcstudio').get<boolean>('openByContent', true);

/**
 * SimaticML files are XML, which VS Code opens in the text editor (an editor of our own as the
 * default for every .xml would take over XML everywhere). A SimaticML block or PLC data type is
 * handed to its view when its text editor comes up, once per file and session, so "Open text"
 * still shows the XML afterwards.
 */
const handedOver = new Set<string>();

async function handOverXml(editor: vscode.TextEditor | undefined): Promise<void> {
  const document = editor?.document;
  if (!document || !/\.xml$/i.test(document.uri.path) || !openByContent()) return;
  const key = document.uri.toString();
  if (handedOver.has(key)) return;
  handedOver.add(key);
  const block = xmlBlock(document);
  const view = block ? xmlView(block) : 'text';
  if (view === 'text') return;
  const tab = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key);
  const options = {
    viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active,
    preview: tab?.isPreview ?? false,
  };
  if (view === 'scl') await openXmlScl(document.uri, options);
  else
    await vscode.commands.executeCommand(
      'vscode.openWith',
      document.uri,
      VIEW_TYPES[view],
      options,
    );
  try {
    if (tab) await vscode.window.tabGroups.close(tab);
  } catch {
    // already replaced by the preview
  }
}

function matchingTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === MATCHING_VIEW &&
        tab.input.uri.toString() === uri.toString(),
    );
}

export function registerOpenByContent({ extension }: FeatureContext): void {
  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, panel, token) {
      const view = contentView(document);
      const target = view === 'text' ? undefined : textEditorViewProvider(VIEW_TYPES[view]);
      if (target) return target.resolveCustomTextEditor(document, panel, token);
      // the text editor in this tab's place; a preview stays a preview
      const preview = matchingTab(document.uri)?.isPreview ?? false;
      await vscode.window.showTextDocument(document, {
        viewColumn: panel.viewColumn ?? vscode.ViewColumn.Active,
        preview,
      });
      try {
        panel.dispose();
      } catch {
        // already replaced by the preview
      }
    },
  };
  extension.subscriptions.push(
    vscode.window.registerCustomEditorProvider(MATCHING_VIEW, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => void handOverXml(editor)),
  );
  registerXmlViews(extension);
  void handOverXml(vscode.window.activeTextEditor);
}
