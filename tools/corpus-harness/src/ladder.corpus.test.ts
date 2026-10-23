// M8: every LAD/FBD network of the corpus is drawn or falls back to its text, never throws.
import { ladderBlockView, parseBytes, type LadderBlockView } from '@plcstudio/core';
import { profileIndex } from '@plcstudio/profiles';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { corpusVersions, loadCases } from './corpus.ts';

const corpusRoot = fileURLToPath(new URL('../../../corpus', import.meta.url));
const profile = profileIndex('V21')!;

const views: { name: string; view: LadderBlockView; text: string }[] = [];
for (const version of corpusVersions(corpusRoot)) {
  for (const c of loadCases(corpusRoot, version)) {
    for (const f of c.files.filter(
      (x) => (x.variant === 'documents' || x.variant === 'vci-sd') && x.extension === '.s7dcl',
    )) {
      const parsed = parseBytes(f.path, new Uint8Array(readFileSync(f.absolutePath)));
      if (parsed?.kind !== 'blocks') continue;
      const resPath = f.absolutePath.replace(/\.s7dcl$/i, '.s7res');
      let resources;
      try {
        const r = parseBytes(resPath, new Uint8Array(readFileSync(resPath)));
        resources = r?.kind === 'resources' ? r : undefined;
      } catch {
        resources = undefined;
      }
      const view = ladderBlockView(parsed, { profile, resources, displayLanguage: 'en-US' });
      if (view && view.networks.some((n) => n.language === 'LAD' || n.language === 'FBD')) {
        views.push({ name: `${c.folder}/${f.path}`, view, text: parsed.source.text });
      }
    }
  }
}

describe('LAD/FBD networks of the corpus', () => {
  it('finds the LAD/FBD blocks', () => {
    expect(views.length).toBeGreaterThanOrEqual(20);
  });

  it.each(views.map((v) => [v.name, v] as const))(
    '%s: every network is drawn or kept as text',
    (_name, v) => {
      for (const n of v.view.networks) {
        expect(['drawn', 'text', 'fallback', 'empty']).toContain(n.kind);
        if (n.kind !== 'drawn') expect(n.text, `network ${n.index}`).toBeTypeOf('string');
      }
    },
  );

  it('draws every network of the clean LAD/FBD cases (no fallback)', () => {
    const clean = views.filter((v) => /^C\d/.test(v.name));
    const fallbacks = clean.flatMap((v) =>
      v.view.networks
        .filter((n) => n.kind === 'fallback')
        .map((n) => `${v.name} #${n.index}: ${n.reason}`),
    );
    expect(fallbacks).toEqual([]);
  });

  it('places every element inside its network and covers its text', () => {
    for (const v of views) {
      for (const n of v.view.networks) {
        if (!n.layout) continue;
        for (const e of n.layout.elements) {
          expect(e.x).toBeGreaterThanOrEqual(0);
          expect(e.x + e.w).toBeLessThanOrEqual(n.layout.width);
          expect(e.y + e.h).toBeLessThanOrEqual(n.layout.height);
          expect(v.text.slice(e.range.start, e.range.end)).toContain(e.instruction);
          expect(e.label.length).toBeGreaterThan(3);
        }
      }
    }
  });

  it('shows titles in the display language', () => {
    const c16 = views.find((v) => v.name.includes('C16-lad-contacts/documents'))!;
    expect(c16.view.networks[0]!.title).toBe('Normally open and normally closed contact');
  });
});
