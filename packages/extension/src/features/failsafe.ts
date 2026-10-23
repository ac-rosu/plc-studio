// Fail-safe blocks (spec, "Fail-safe blocks"): marked in the explorer and in the text editor, and
// every save shows a non-modal reminder that TIA must recompile and the change must be accepted.
// PLC Studio makes no safety-certification claim.
import * as vscode from 'vscode';
import { parseBlockText, type BlockFile } from '@plcstudio/core';
import type { FeatureContext } from './index.ts';
import { workspaceModel, type PlcWorkspaceModel } from './tables-workspace.ts';

export const FAILSAFE_NOTICE =
  'Fail-safe block: after changing it, compile the safety program in TIA Portal. The collective F-signature changes and the change must be accepted by a qualified person. PLC Studio is not a safety-certified tool.';

/** Whether a block file holds a fail-safe block: S7_Safety in the file, or the manifest's list. */
export function isFailsafeDocument(
  path: string,
  text: string,
  ws: PlcWorkspaceModel | undefined,
): boolean {
  if (!/\.(s7dcl|scl|db|udt)$/i.test(path)) return false;
  if (ws) {
    const project = ws.workspace.projectFor(path);
    const blocks = project.index.blocks.filter(
      (b) => b.file.path.toLowerCase() === path.toLowerCase(),
    );
    if (blocks.length > 0) return blocks.some((b) => b.failsafe);
  }
  const parsed: BlockFile = parseBlockText(text, /\.s7dcl$/i.test(path) ? 's7dcl' : 'source');
  return parsed.blocks.some((b) =>
    b.attributes.some((a) => a.name === 'S7_Safety' && /^true$/i.test(a.value)),
  );
}

class FailsafeDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly ws: PlcWorkspaceModel;

  constructor(ws: PlcWorkspaceModel) {
    this.ws = ws;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file' || !/\.(s7dcl|scl|db|udt)$/i.test(uri.path)) return undefined;
    const path = this.ws.pathOf(uri);
    const project = this.ws.workspace.projectFor(path);
    const failsafe = project.index.blocks.some(
      (b) => b.file.path.toLowerCase() === path.toLowerCase() && b.failsafe,
    );
    if (!failsafe) return undefined;
    return {
      badge: 'F',
      tooltip: 'Fail-safe block',
      color: new vscode.ThemeColor('editorWarning.foreground'),
    };
  }
}

export function registerFailsafe({ extension }: FeatureContext): void {
  const ws = workspaceModel(extension);
  const decorations = new FailsafeDecorations(ws);
  const banner = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: {
      contentText:
        '  ⚠ Fail-safe block: recompile and re-accept the safety program in TIA after changes. PLC Studio is not a safety-certified tool.',
      color: new vscode.ThemeColor('editorWarning.foreground'),
      fontStyle: 'italic',
    },
  });
  const mark = (editors: readonly vscode.TextEditor[]) => {
    for (const editor of editors) {
      const d = editor.document;
      const failsafe =
        d.uri.scheme === 'file' && isFailsafeDocument(ws.pathOf(d.uri), d.getText(), ws);
      editor.setDecorations(banner, failsafe ? [new vscode.Range(0, 0, 0, 0)] : []);
    }
  };
  extension.subscriptions.push(
    banner,
    vscode.window.registerFileDecorationProvider(decorations),
    ws.onDidChange(() => {
      decorations.refresh();
      mark(vscode.window.visibleTextEditors);
    }),
    vscode.window.onDidChangeVisibleTextEditors(mark),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.scheme === 'file' && isFailsafeDocument(ws.pathOf(d.uri), d.getText(), ws)) {
        void vscode.window.showWarningMessage(`PLC Studio: ${FAILSAFE_NOTICE}`);
      }
    }),
  );
  void ws.ready.then(() => {
    decorations.refresh();
    mark(vscode.window.visibleTextEditors);
  });
}
