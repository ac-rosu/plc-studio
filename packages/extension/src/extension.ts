// VS Code client: starts the language server for PLC Studio's own language ids (ADR 0009) and
// registers the features (commands, views, custom editors).
import * as path from 'node:path';
import type { ExtensionContext } from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { registerFeatures } from './features/index.ts';
import { LANGUAGE_IDS } from './language-ids.ts';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: LANGUAGE_IDS.map((language) => ({ language })),
  };
  client = new LanguageClient('plcstudio', 'PLC Studio', serverOptions, clientOptions);
  await client.start();
  registerFeatures({ extension: context, client });
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
