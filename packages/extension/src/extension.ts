// VS Code client: starts the language server for PLC Studio's own language ids (ADR 0009),
// gives it file access through vscode.workspace.fs (so the server stays web-safe) and registers
// the features (commands, views, custom editors).
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { registerFeatures } from './features/index.ts';
import { LANGUAGE_IDS } from './language-ids.ts';

let client: LanguageClient | undefined;

/** Files the language server reads (PLC files, manifests, rules). */
export const WATCH_GLOB =
  '**/{*.s7dcl,*.s7res,*.scl,*.udt,*.db,*.xml,plc.json,plcstudio.rules.json}';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };
  const watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
  context.subscriptions.push(watcher);
  const clientOptions: LanguageClientOptions = {
    documentSelector: LANGUAGE_IDS.map((language) => ({ language })),
    synchronize: { fileEvents: watcher, configurationSection: 'plcstudio' },
  };
  client = new LanguageClient('plcstudio', 'PLC Studio', serverOptions, clientOptions);
  client.onRequest('plcstudio/readDirectory', async ({ uri }: { uri: string }) => {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.parse(uri));
      return entries.map(([name, type]) => [name, (type & vscode.FileType.Directory) !== 0]);
    } catch {
      return null;
    }
  });
  client.onRequest('plcstudio/readFile', async ({ uri }: { uri: string }) => {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(uri));
      return Buffer.from(bytes).toString('base64');
    } catch {
      return null;
    }
  });
  await client.start();
  registerFeatures({ extension: context, client });
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
