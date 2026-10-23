// Coexistence with other SCL extensions (ADR 0009): detect extensions that claim the same file
// types and offer a one-click switch of the file association. Other extensions are never
// disabled or reconfigured.
import * as vscode from 'vscode';
import type { FeatureContext } from './index.ts';

const OUR_ASSOCIATIONS: Record<string, string> = {
  '*.scl': 'plcstudio-scl',
  '*.udt': 'plcstudio-scl',
  '*.db': 'plcstudio-scl',
  '*.s7dcl': 'plcstudio-s7dcl',
  '*.s7res': 'plcstudio-s7res',
};

interface LanguageContribution {
  id?: string;
  extensions?: string[];
}

/** Other installed extensions that register a language for one of our file extensions. */
export function competingExtensions(): { id: string; name: string; extensions: string[] }[] {
  const ours = new Set(Object.keys(OUR_ASSOCIATIONS).map((p) => p.slice(1).toLowerCase()));
  const out: { id: string; name: string; extensions: string[] }[] = [];
  for (const ext of vscode.extensions.all) {
    if (ext.id.toLowerCase() === 'acro.plcstudio' || ext.id.startsWith('vscode.')) continue;
    const languages =
      (ext.packageJSON as { contributes?: { languages?: LanguageContribution[] } })?.contributes
        ?.languages ?? [];
    const claimed = languages
      .flatMap((l) => (l.extensions ?? []).map((e) => e.toLowerCase()))
      .filter((e) => ours.has(e));
    if (claimed.length > 0) {
      out.push({
        id: ext.id,
        name: (ext.packageJSON as { displayName?: string }).displayName ?? ext.id,
        extensions: [...new Set(claimed)],
      });
    }
  }
  return out;
}

export function registerCoexistence({ extension }: FeatureContext): void {
  extension.subscriptions.push(
    vscode.commands.registerCommand('plcstudio.useForPlcFiles', () =>
      useForPlcFiles(vscode.ConfigurationTarget.Workspace),
    ),
  );
  void check(extension);
}

async function useForPlcFiles(target: vscode.ConfigurationTarget): Promise<void> {
  const config = vscode.workspace.getConfiguration('files');
  const current = { ...(config.get<Record<string, string>>('associations') ?? {}) };
  await config.update('associations', { ...current, ...OUR_ASSOCIATIONS }, target);
  void vscode.window.showInformationMessage(
    'PLC Studio now opens .scl, .udt, .db, .s7dcl and .s7res files. Other extensions were not changed.',
  );
}

async function check(context: vscode.ExtensionContext): Promise<void> {
  const others = competingExtensions();
  if (others.length === 0) return;
  const associations =
    vscode.workspace.getConfiguration('files').get<Record<string, string>>('associations') ?? {};
  const alreadyOurs = Object.entries(OUR_ASSOCIATIONS).every(([k, v]) => associations[k] === v);
  const key = `plcstudio.coexistence.${others
    .map((o) => o.id)
    .sort()
    .join(',')}`;
  if (alreadyOurs || context.globalState.get(key)) return;
  await context.globalState.update(key, true);
  const names = others.map((o) => `${o.name} (${o.extensions.join(', ')})`).join('; ');
  const choice = await vscode.window.showInformationMessage(
    `Other extensions also handle PLC files: ${names}. Two extensions on the same files give duplicate diagnostics and completions.`,
    'Use PLC Studio for these files',
    'Keep as is',
  );
  if (choice === 'Use PLC Studio for these files')
    await useForPlcFiles(vscode.ConfigurationTarget.Workspace);
}
