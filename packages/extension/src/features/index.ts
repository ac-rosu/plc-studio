// Every feature registers itself here. Each feature lives in its own module so features can be
// developed side by side; add one line per feature.
import type * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { registerFailsafe } from './failsafe.ts';
import { registerGraph } from './graph.ts';
import { registerTables } from './tables.ts';
import { registerTagTable } from './tagtable.ts';

export interface FeatureContext {
  readonly extension: vscode.ExtensionContext;
  /** The language client; started before features are registered. */
  readonly client: LanguageClient;
}

export type Feature = (context: FeatureContext) => void;

const features: Feature[] = [registerTables, registerTagTable, registerGraph, registerFailsafe];

export function registerFeatures(context: FeatureContext): void {
  for (const feature of features) feature(context);
}
