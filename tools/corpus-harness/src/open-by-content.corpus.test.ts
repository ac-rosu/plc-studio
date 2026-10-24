// Opening by content (M13.3): every block file of the corpus goes to the view its blocks call for,
// judged by what TIA reported about them in expected.json (object type and language).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SourceText, parseBlockText } from '@plcstudio/core';
import {
  viewForContent,
  type ContentView,
} from '../../../packages/extension/src/features/open-by-content-model.ts';
import { corpusVersions, loadCases } from './corpus.ts';
import type { ExpectedCase } from './expected.ts';

const corpusRoot = fileURLToPath(new URL('../../../corpus', import.meta.url));
const all = corpusVersions(corpusRoot).flatMap((version) => loadCases(corpusRoot, version));

type ExpectedObject = ExpectedCase['objects'][number];
const DATA_BLOCKS = new Set(['GlobalDB', 'InstanceDB', 'ArrayDB']);
const LADDER = new Set(['LAD', 'FBD', 'F_LAD', 'F_FBD']);

function expectedView(objects: readonly ExpectedObject[], format: 's7dcl' | 'source'): ContentView {
  if (objects.length === 0) return 'text';
  if (objects.every((o) => DATA_BLOCKS.has(o.type))) return 'datablock';
  if (objects.every((o) => o.type === 'UDT')) return 'interface';
  if (format === 's7dcl' && objects.length === 1 && LADDER.has(objects[0]!.language ?? ''))
    return 'ladder';
  return 'text';
}

const files = all.flatMap((c) =>
  c.files
    .filter(
      (f) =>
        (f.variant === 'documents' && f.extension === '.s7dcl') ||
        (f.variant === 'source' && ['.scl', '.db', '.udt'].includes(f.extension)),
    )
    .map((f) => ({ c, f })),
);

describe('opening by content', () => {
  it.each(files.map(({ c, f }) => [`${c.folder}/${f.path}`, c, f] as const))(
    '%s',
    (_name, c, f) => {
      const format = f.variant === 'documents' ? 's7dcl' : 'source';
      const parsed = parseBlockText(
        SourceText.fromBytes(new Uint8Array(readFileSync(f.absolutePath))).text,
        format,
      );
      const objects = parsed.blocks.map((b) => {
        const o = c.expected.objects.find(
          (x) => x.name === b.name.text || x.name.endsWith(`.${b.name.text}`),
        );
        if (!o) throw new Error(`${b.name.text} is not an object of ${c.folder}`);
        return o;
      });
      expect(viewForContent(parsed)).toBe(expectedView(objects, format));
    },
  );

  it('covers every kind of view', () => {
    const views = new Set(
      files.map(({ f }) =>
        viewForContent(
          parseBlockText(
            SourceText.fromBytes(new Uint8Array(readFileSync(f.absolutePath))).text,
            f.variant === 'documents' ? 's7dcl' : 'source',
          ),
        ),
      ),
    );
    expect([...views].sort()).toEqual(['datablock', 'interface', 'ladder', 'text']);
  });
});
