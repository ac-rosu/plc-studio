// F-block detection on the corpus (spec, "Fail-safe blocks"): C24 holds F-blocks, C16 and C19 the
// same languages as standard blocks.
import { Project, SourceText } from '@plcstudio/core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../corpus/V21', import.meta.url));

function project(cases: string[], folder = 'documents', failsafeCpu = true): Project {
  const p = new Project('/plc');
  p.setManifest(
    '/plc/plc.json',
    JSON.stringify({
      name: 'P',
      cpu: { family: 'S7-1500', failsafe: failsafeCpu },
      tiaVersion: 'V21',
    }),
  );
  for (const c of cases) {
    const dir = `${root}/${c}/${folder}`;
    for (const f of readdirSync(dir))
      p.setFile(`/plc/${f}`, SourceText.fromBytes(new Uint8Array(readFileSync(`${dir}/${f}`))));
  }
  return p;
}

describe('fail-safe detection', () => {
  it('recognizes every C24 block as fail-safe and no C16/C19 block', () => {
    const blocks = project(['C24-failsafe', 'C16-lad-contacts', 'C19-fbd-logic']).index.blocks;
    const failsafe = blocks
      .filter((b) => b.failsafe)
      .map((b) => b.name)
      .sort();
    expect(failsafe).toEqual([
      'F_DB_Settings',
      'F_FB_MainSafety',
      'F_FC_Logic',
      'F_IDB_MainSafety',
      'UDT_FSignals',
    ]);
    expect(
      blocks
        .filter((b) => !b.failsafe)
        .map((b) => b.name)
        .sort(),
    ).toEqual(['FC_FbdLogic', 'FC_LadContacts']);
  });

  it('treats an F-DB external source as standard and flags it as info', async () => {
    const { analyzeProject } = await import('@plcstudio/core');
    const p = project(['C24-failsafe'], 'source');
    const symbol = p.index.blocks.find((b) => b.name === 'F_DB_Settings')!;
    expect(symbol.failsafe).toBe(false);
    const diags = [...analyzeProject(p).diagnostics.values()]
      .flat()
      .filter((d) => d.code === 'failsafe-unknown');
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.severity === 'info')).toBe(true);
  });

  it('uses the manifest list as fallback', () => {
    const p = new Project('/plc');
    p.setManifest(
      '/plc/plc.json',
      JSON.stringify({
        name: 'P',
        cpu: { family: 'S7-1500', failsafe: true },
        tiaVersion: 'V21',
        failsafeBlocks: ['F_DB_Settings'],
      }),
    );
    p.setFile(
      '/plc/F_DB_Settings.db',
      SourceText.fromBytes(
        new Uint8Array(readFileSync(`${root}/C24-failsafe/source/F_DB_Settings.db`)),
      ),
    );
    expect(p.index.blocks[0]!.failsafe).toBe(true);
  });
});
