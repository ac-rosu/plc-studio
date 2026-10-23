import { TextDocumentSyncKind } from 'vscode-languageserver';
import { describe, expect, it } from 'vitest';
import { serverCapabilities } from './server.ts';

describe('server capabilities', () => {
  it('syncs documents incrementally', () => {
    expect(serverCapabilities().textDocumentSync).toBe(TextDocumentSyncKind.Incremental);
  });
});
