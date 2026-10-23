// Every feature registers itself here. Each feature lives in its own module so features can be
// developed side by side; add one line per feature.
import type * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { registerCallGraph } from './callgraph.ts';
import { registerCoexistence } from './coexistence.ts';
import { registerCommands } from './commands.ts';
import { registerFailsafe } from './failsafe.ts';
import { registerGraph } from './graph.ts';
import { registerLadderEditor } from './ladder-editor.ts';
import { registerManifest } from './manifest.ts';
import { registerTables } from './tables.ts';
import { registerTagTable } from './tagtable.ts';

export interface FeatureContext {
  readonly extension: vscode.ExtensionContext;
  /** The language client; started before features are registered. */
  readonly client: LanguageClient;
}

export type Feature = (context: FeatureContext) => void;

const features: Feature[] = [
  registerCommands,
  registerManifest,
  registerCoexistence,
  registerLadderEditor,
  registerCallGraph,
  registerTables,
  registerTagTable,
  registerGraph,
  registerFailsafe,
];

export function registerFeatures(context: FeatureContext): void {
  for (const feature of features) feature(context);
}
