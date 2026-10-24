// What the webviews report back: which view types drew an update, and the script errors they hit.
// Errors go to the PLC Studio output channel; the integration tests read the record through the
// hidden command plcstudio.internal.viewHealth.
import * as vscode from 'vscode';

const rendered = new Map<string, number>();
const errors: string[] = [];
let output: vscode.OutputChannel | undefined;

/** Handles `rendered` and `viewError`; returns true when the message was one of them. */
export function viewHealthMessage(
  viewType: string,
  message: { type: string; [key: string]: unknown },
): boolean {
  if (message.type === 'rendered') {
    rendered.set(viewType, (rendered.get(viewType) ?? 0) + 1);
    return true;
  }
  if (message.type === 'viewError') {
    const text = `${viewType}: ${String(message['message'])}`;
    errors.push(text);
    output ??= vscode.window.createOutputChannel('PLC Studio Views');
    output.appendLine(text);
    return true;
  }
  return false;
}

export function registerViewHealth(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('plcstudio.internal.viewHealth', () => ({
      rendered: [...rendered.keys()],
      renders: Object.fromEntries(rendered),
      errors: [...errors],
    })),
    { dispose: () => output?.dispose() },
  );
}
