// General commands: references from CodeLens, restarting the server, profile coverage.
import * as vscode from 'vscode';
import { PROFILES } from '@plcstudio/profiles';
import type { FeatureContext } from './index.ts';

export function registerCommands({ extension, client }: FeatureContext): void {
  extension.subscriptions.push(
    vscode.commands.registerCommand(
      'plcstudio.showReferences',
      async (uri: string, position: { line: number; character: number }) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(position.line, position.character);
        editor.selection = new vscode.Selection(pos, pos);
        await vscode.commands.executeCommand('editor.action.referenceSearch.trigger');
      },
    ),
    vscode.commands.registerCommand('plcstudio.restartServer', async () => {
      await client.restart();
      void vscode.window.showInformationMessage('PLC Studio: language server restarted.');
    }),
    vscode.commands.registerCommand('plcstudio.showProfileCoverage', async () => {
      const used =
        ((await client.sendRequest('plcstudio/instructionUsage').catch(() => [])) as {
          name: string;
          known: boolean;
          count: number;
        }[]) ?? [];
      const doc = await vscode.workspace.openTextDocument({
        content: profileCoverage(used),
        language: 'markdown',
      });
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    }),
  );
}

export function profileCoverage(used: { name: string; known: boolean; count: number }[]): string {
  const lines: string[] = [];
  for (const profile of Object.values(PROFILES)) {
    const groups: [
      string,
      { name: string; verification: { verified: boolean; cases?: string[] } }[],
    ][] = [
      ['Instructions', profile.instructions],
      ['System data types', profile.systemTypes],
      ['Elementary data types', profile.elementaryTypes],
      ['LAD/FBD elements', profile.ladderElements],
    ];
    lines.push(`# Version profile ${profile.id}`, '');
    lines.push(
      'Verified entries are backed by a corpus case that TIA compiled. Diagnostics that depend on unverified entries are warnings, never errors.',
      '',
    );
    for (const [title, entries] of groups) {
      const verified = entries.filter((e) => e.verification.verified);
      lines.push(`## ${title}: ${verified.length} of ${entries.length} verified`, '');
      lines.push('| Name | Status | Corpus cases |', '| --- | --- | --- |');
      for (const e of entries)
        lines.push(
          `| ${e.name} | ${e.verification.verified ? 'verified' : 'unverified'} | ${(e.verification.cases ?? []).join(', ')} |`,
        );
      lines.push('');
    }
  }
  const missing = used.filter((u) => !u.known);
  lines.push('## Instructions used in this workspace but missing from the profile', '');
  if (missing.length === 0) lines.push('None.');
  else {
    lines.push('| Name | Calls |', '| --- | --- |');
    for (const m of missing.sort((a, b) => b.count - a.count))
      lines.push(`| ${m.name} | ${m.count} |`);
  }
  return lines.join('\n') + '\n';
}
