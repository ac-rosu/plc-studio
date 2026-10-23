// The formatter reproduces TIA's own layout: formatting a whole corpus file changes nothing.
import { formatDocument, SourceText } from '@plcstudio/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { corpusVersions, loadCases } from './corpus.ts';

const corpusRoot = fileURLToPath(new URL('../../../corpus', import.meta.url));
const files = corpusVersions(corpusRoot)
  .flatMap((v) => loadCases(corpusRoot, v))
  .flatMap((c) =>
    c.files
      .filter(
        (f) =>
          f.extension === '.s7dcl' ||
          f.extension === '.scl' ||
          f.extension === '.udt' ||
          f.extension === '.db',
      )
      .map((f) => [`${c.folder}/${f.path}`, f.absolutePath] as const),
  );

describe('formatter on TIA-written files', () => {
  it.each(files)('%s: formatting the whole document changes nothing', (_, absolutePath) => {
    const source = SourceText.fromBytes(new Uint8Array(readFileSync(absolutePath)));
    const edits = formatDocument(absolutePath, source.text);
    const preview = edits
      .slice(0, 3)
      .map(
        (e) =>
          `${source.positionAt(e.start).line + 1}: ${JSON.stringify(source.text.slice(e.start, e.end))} -> ${JSON.stringify(e.newText)}`,
      );
    expect(preview).toEqual([]);
  });
});
