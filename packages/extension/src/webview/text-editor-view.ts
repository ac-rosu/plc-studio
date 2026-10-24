// A custom editor over a text file (spec, "Graphical and table editors"): the text document stays
// the single source of truth, every edit goes through a WorkspaceEdit (so VS Code's undo/redo
// works), and the view refreshes whenever the text changes, also when edited side by side.
import * as vscode from 'vscode';
import type { TextEdit } from '@plcstudio/core';
import { viewHealthMessage } from './health.ts';
import { webviewHtml } from './html.ts';

export interface ViewContext {
  readonly document: vscode.TextDocument;
  readonly webview: vscode.Webview;
  /** Applies core text edits to the document as one undoable step. */
  applyEdits(edits: readonly TextEdit[], label?: string): Promise<boolean>;
  /** Opens the text at a range beside or in place of the view. */
  revealText(start: number, end: number): Promise<void>;
  /** Sends the current model again. */
  refresh(): void;
}

export interface TextEditorViewOptions<Model> {
  readonly viewType: string;
  /** Bundle name under dist/webviews. */
  readonly view: string;
  readonly title: (document: vscode.TextDocument) => string;
  /** Builds what the view shows from the current text. */
  readonly model: (document: vscode.TextDocument, context: vscode.ExtensionContext) => Model;
  /**
   * Other files the view depends on (UDTs, FBs, the .s7res): the view refreshes when `affects`
   * says a change of those paths matters to its document.
   */
  readonly otherFiles?: {
    readonly onDidChange: vscode.Event<readonly string[]>;
    readonly affects: (document: vscode.TextDocument, paths: readonly string[]) => boolean;
  };
  /** Handles a message from the view (edits, reveal requests ...). */
  readonly onMessage?: (
    message: { type: string; [key: string]: unknown },
    view: ViewContext,
  ) => void | Promise<void>;
}

export function registerTextEditorView<Model>(
  context: vscode.ExtensionContext,
  options: TextEditorViewOptions<Model>,
): vscode.Disposable {
  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, panel) {
      const webview = panel.webview;
      webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews')],
      };
      webview.html = webviewHtml(
        webview,
        context.extensionUri,
        options.view,
        options.title(document),
      );
      let ready = false;
      const send = () => {
        if (!ready) return;
        try {
          void webview.postMessage({
            type: 'update',
            model: options.model(document, context),
            version: document.version,
          });
        } catch (e) {
          void webview.postMessage({ type: 'error', message: (e as Error).message });
        }
      };
      const view: ViewContext = {
        document,
        webview,
        async applyEdits(edits, label) {
          if (edits.length === 0) return true;
          const edit = new vscode.WorkspaceEdit();
          for (const e of edits) {
            edit.replace(
              document.uri,
              new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)),
              e.newText,
            );
          }
          const ok = await vscode.workspace.applyEdit(
            edit,
            label ? { isRefactoring: false } : undefined,
          );
          return ok;
        },
        async revealText(start, end) {
          const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: true,
          });
          const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
          editor.selection = new vscode.Selection(range.start, range.end);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        },
        refresh: send,
      };
      const changes = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString()) send();
      });
      const diagnostics = vscode.languages.onDidChangeDiagnostics((e) => {
        if (e.uris.some((u) => u.toString() === document.uri.toString())) send();
      });
      const others = options.otherFiles?.onDidChange((paths) => {
        if (options.otherFiles!.affects(document, paths)) send();
      });
      panel.onDidDispose(() => {
        changes.dispose();
        diagnostics.dispose();
        others?.dispose();
      });
      webview.onDidReceiveMessage(async (message: { type: string; [key: string]: unknown }) => {
        if (viewHealthMessage(options.viewType, message)) return;
        if (message.type === 'ready') {
          ready = true;
          send();
          return;
        }
        if (
          message.type === 'reveal' &&
          typeof message['start'] === 'number' &&
          typeof message['end'] === 'number'
        ) {
          await view.revealText(message['start'], message['end']);
          return;
        }
        if (message.type === 'openText') {
          await vscode.commands.executeCommand(
            'vscode.openWith',
            document.uri,
            'default',
            vscode.ViewColumn.Beside,
          );
          return;
        }
        try {
          await options.onMessage?.(message, view);
        } catch (e) {
          void vscode.window.showErrorMessage(`PLC Studio: ${(e as Error).message}`);
        }
      });
    },
  };
  return vscode.window.registerCustomEditorProvider(options.viewType, provider, {
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: true,
  });
}

/** Diagnostics of a document as plain data for a view. */
export function diagnosticsFor(
  document: vscode.TextDocument,
): { start: number; end: number; severity: 'error' | 'warning' | 'info'; message: string }[] {
  return vscode.languages.getDiagnostics(document.uri).map((d) => ({
    start: document.offsetAt(d.range.start),
    end: document.offsetAt(d.range.end),
    severity:
      d.severity === vscode.DiagnosticSeverity.Error
        ? 'error'
        : d.severity === vscode.DiagnosticSeverity.Warning
          ? 'warning'
          : 'info',
    message: d.message,
  }));
}
