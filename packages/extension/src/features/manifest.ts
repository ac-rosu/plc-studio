// "PLC Studio: Create manifest": scans a folder and proposes a plc.json (spec, "PLC folder and
// manifest"). Without a manifest only syntax is checked, so the extension offers to create one.
import * as vscode from 'vscode';
import { proposeManifest } from '@plcstudio/core';
import type { FeatureContext } from './index.ts';

const PLC_FILES = '**/*.{s7dcl,scl,udt,db}';

export function registerManifest({ extension }: FeatureContext): void {
  extension.subscriptions.push(
    vscode.commands.registerCommand('plcstudio.createManifest', async (folder?: vscode.Uri) => {
      const target = folder ?? (await pickFolder());
      if (target) await createManifest(target);
    }),
  );
  void promptForMissingManifest(extension);
}

async function pickFolder(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: 'Create plc.json here',
    ...(vscode.workspace.workspaceFolders?.[0]
      ? { defaultUri: vscode.workspace.workspaceFolders[0].uri }
      : {}),
  });
  return picked?.[0];
}

export async function createManifest(folder: vscode.Uri): Promise<void> {
  const manifestUri = vscode.Uri.joinPath(folder, 'plc.json');
  try {
    await vscode.workspace.fs.stat(manifestUri);
    const open = await vscode.window.showWarningMessage(
      'This folder already has a plc.json.',
      'Open it',
    );
    if (open) await vscode.window.showTextDocument(manifestUri);
    return;
  } catch {
    // no manifest yet
  }
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, PLC_FILES),
    '**/node_modules/**',
    5000,
  );
  const units = new Map<string, { name: string; folder: string; namespace: string }>();
  let failsafe = false;
  const cultures = new Set<string>();
  for (const file of files) {
    const text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
    if (/S7_Safety\s*:=\s*"true"/i.test(text)) failsafe = true;
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const ns = /^\s*NAMESPACE\s+([A-Za-z_][\w.]*)/m.exec(body)?.[1];
    if (ns) {
      const relative = vscode.workspace.asRelativePath(vscode.Uri.joinPath(file, '..'), false);
      const base = vscode.workspace.asRelativePath(folder, false);
      const unitFolder = relative.startsWith(base)
        ? relative.slice(base.length).replace(/^[/\\]/, '')
        : relative;
      // the unit folder is the folder holding "Program blocks" etc., or the file's folder
      const topFolder =
        unitFolder
          .split(/[/\\]/)
          .slice(0, unitFolder.includes('Units') ? 2 : 1)
          .join('/') || '.';
      if (!units.has(ns)) units.set(ns, { name: ns, folder: topFolder, namespace: ns });
    }
  }
  for (const res of await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*.s7res'),
    undefined,
    200,
  )) {
    const text = Buffer.from(await vscode.workspace.fs.readFile(res)).toString('utf8');
    for (const m of text.matchAll(/^\s+([a-z]{2,3}-[A-Z]{2,4}):/gm)) cultures.add(m[1]!);
  }
  const family = await vscode.window.showQuickPick(['S7-1500', 'S7-1200'], {
    title: 'PLC Studio: CPU family of this PLC',
    placeHolder: 'The exported files do not say which CPU family the program is for',
  });
  if (!family) return;
  const name = folder.path.split('/').filter(Boolean).pop() ?? 'PLC';
  const displayLanguage = cultures.has('en-US') ? 'en-US' : [...cultures][0];
  const text = proposeManifest({
    name,
    family: family as 'S7-1500' | 'S7-1200',
    failsafe,
    units: [...units.values()],
    displayLanguage,
  });
  await vscode.workspace.fs.writeFile(manifestUri, Buffer.from(text, 'utf8'));
  await vscode.window.showTextDocument(manifestUri);
  if (units.size > 0) {
    void vscode.window.showInformationMessage(
      'PLC Studio: check the unit folders, relations and published objects in plc.json; the exported files do not contain unit relations.',
    );
  }
}

/** Offers to create a manifest once per workspace folder that has PLC files but no plc.json. */
async function promptForMissingManifest(context: vscode.ExtensionContext): Promise<void> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const key = `plcstudio.manifestPrompted.${folder.uri.toString()}`;
    if (context.workspaceState.get(key)) continue;
    const manifests = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/plc.json'),
      '**/node_modules/**',
      1,
    );
    if (manifests.length > 0) continue;
    const plcFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, PLC_FILES),
      '**/node_modules/**',
      1,
    );
    if (plcFiles.length === 0) continue;
    await context.workspaceState.update(key, true);
    const choice = await vscode.window.showInformationMessage(
      `PLC Studio found PLC files in ${folder.name} without a plc.json. Without it only syntax is checked.`,
      'Create plc.json',
      'Not now',
    );
    if (choice === 'Create plc.json') await createManifest(folder.uri);
  }
}
