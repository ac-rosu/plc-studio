// The corpus itself: well-formed, complete, and the gates pass (M0.7, M0.8).
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import schema from '../schema/expected.schema.json' with { type: 'json' };
import {
  assemblePlcs,
  corpusVersions,
  filesOnDisk,
  isTiaClean,
  listedFiles,
  loadCases,
} from './corpus.ts';
import { POLICY_EXPECTATIONS } from './gates.ts';
import { corePrinter, corpusProject, projectChecker } from './core-adapters.ts';
import { demoPlcs } from './demo-plcs.ts';
import { renderReport } from './report.ts';
import { gatesPassed, runGates } from './run.ts';
import { tiaLocation } from './tia-location.ts';
import { SourceText, outline, parseTagTable } from '@plcstudio/core';

const corpusRoot = fileURLToPath(new URL('../../../corpus', import.meta.url));
const validate = new Ajv({ allErrors: true }).compile(schema);
const versions = corpusVersions(corpusRoot);
const all = versions.flatMap((version) => loadCases(corpusRoot, version));

describe('corpus', () => {
  it('has V21', () => {
    expect(versions).toContain('V21');
  });

  it('V21 has 101 cases: 44 clean, 14 analyzer, 43 broken', () => {
    // 65 from the corpus build, 20 from verification batch 1, 13 from batch 2, C41, B46, C42 (2026-10-24)
    const v21 = all.filter((c) => c.version === 'V21');
    const count = (kind: string) => v21.filter((c) => c.expected.kind === kind).length;
    expect([v21.length, count('clean'), count('analyzer'), count('broken')]).toEqual([
      101, 44, 14, 43,
    ]);
  });

  it.each(all.map((c) => [`${c.version}/${c.folder}`, c] as const))(
    '%s: expected.json matches the schema',
    (_, c) => {
      expect(validate(c.expected), JSON.stringify(validate.errors)).toBe(true);
      expect(c.folder.startsWith(`${c.expected.caseId}-`)).toBe(true);
      expect(c.expected.tiaVersion).toBe(c.version);
    },
  );

  it.each(all.map((c) => [`${c.version}/${c.folder}`, c] as const))(
    '%s: files on disk are exactly the listed exports',
    (_, c) => {
      expect(filesOnDisk(c.directory)).toEqual([...listedFiles(c.expected)].sort());
    },
  );

  it('assembles every PLC in every variant without conflicting objects', () => {
    for (const variant of ['documents', 'vci', 'source'] as const) {
      const plcs = assemblePlcs(all, variant);
      expect(plcs.map((p) => p.name).sort()).toEqual(['PLC_1200', 'PLC_Main']);
    }
  });

  it('policy expectations point at TIA-clean cases and existing blocks', () => {
    for (const p of POLICY_EXPECTATIONS) {
      const c = all.find((x) => x.version === p.version && x.expected.caseId === p.caseId);
      expect(c, `${p.version}/${p.caseId}`).toBeDefined();
      expect(isTiaClean(c!)).toBe(true);
      expect(c!.expected.objects.map((o) => o.name)).toContain(p.block);
    }
  });
});

// The line mapping, checked against the table in format-findings.md (finding 4).
describe('TIA line mapping on corpus files', () => {
  const at = (relative: string, fileLine: number) => {
    const extension = relative.slice(relative.lastIndexOf('.'));
    return tiaLocation(readFileSync(`${corpusRoot}/V21/${relative}`, 'utf8'), fileLine, extension);
  };

  it.each([
    ['B01-undeclared-variable/source/FB_SclSections_B01.scl', 107, { kind: 'line', line: 64 }],
    ['B01-undeclared-variable/documents/FB_SclSections_B01.s7dcl', 121, { kind: 'line', line: 64 }],
    ['B04-wrong-parameter-name/source/FB_SclCalls_B04.scl', 43, { kind: 'line', line: 3 }],
    ['B04-wrong-parameter-name/documents/FB_SclCalls_B04.s7dcl', 58, { kind: 'line', line: 3 }],
    ['B21-unpublished-access/source/FB_Doser_B21.scl', 24, { kind: 'line', line: 3 }],
    ['B21-unpublished-access/documents/FB_Doser_B21.s7dcl', 32, { kind: 'line', line: 3 }],
    ['B19-lad-unwired-input/documents/FB_LadBoxes_B19.s7dcl', 86, { kind: 'network', network: 3 }],
    ['B25-mixed-scl-syntax/documents/FB_Mixed_B25.s7dcl', 44, { kind: 'network', network: 2 }],
  ] as const)('%s line %i', (relative, fileLine, location) => {
    expect(at(relative, fileLine)).toEqual(location);
  });
});

describe('gates', () => {
  const baseline = JSON.parse(
    readFileSync(new URL('../baseline.json', import.meta.url), 'utf8'),
  ) as Record<string, Record<string, number>>;

  it('pass with the core parsers and the project checker', async () => {
    const run = await runGates(corpusRoot, corePrinter, projectChecker(corpusRoot));
    const report = renderReport(run);
    // round trip 100% and zero false errors
    expect(gatesPassed(run), report).toBe(true);
    const v21 = run.versions.find((v) => v.version === 'V21')!;
    expect(v21.roundTrip.checked).toBeGreaterThan(400);
    // every analyzer expectation of the corpus is reported (rule, block, line or member)
    for (const p of v21.plcs) {
      const missed = p.analyzer.filter((a) => !a.found).map((a) => `${a.caseFolder} ${a.rule}`);
      expect(missed, `${p.plc}/${p.variant}`).toEqual([]);
    }
    // the expected policy errors (ADR 0013) are reported
    for (const p of v21.plcs)
      expect(
        p.policy.every((r) => r.found),
        `${p.plc}/${p.variant}`,
      ).toBe(true);
    // error coverage never drops below the recorded baseline
    for (const p of v21.plcs) {
      const floor = baseline['V21']?.[`${p.plc}/${p.variant}`] ?? 0;
      expect(p.coverage.matched, `${p.plc}/${p.variant}\n${report}`).toBeGreaterThanOrEqual(floor);
    }
  });
});

// The two SimaticML styles of tag tables: VCI leaves default attributes out (C04), an Openness
// export writes them (C41). Both must read the same way.
describe('tag tables in both SimaticML styles', () => {
  const table = (relative: string) =>
    parseTagTable(
      SourceText.fromBytes(new Uint8Array(readFileSync(`${corpusRoot}/V21/${relative}`))),
    );

  it('reads an Openness export with every default attribute written (C41)', () => {
    const t = table('C41-tag-table-openness/tagtables/Tags_Openness.xml');
    expect(
      t.entries.map((e) => [
        e.kind,
        e.name,
        e.dataType,
        e.address ?? e.value,
        e.accessible,
        e.writable,
      ]),
    ).toEqual([
      ['tag', 'OpnStart', 'Bool', '%I4.0', true, true],
      ['tag', 'OpnFlow', 'Word', '%IW6', true, true],
      ['tag', 'OpnLamp', 'Bool', '%Q4.0', true, true],
      ['tag', 'OpnHelper', 'Bool', '%M20.0', true, true],
      ['tag', 'OpnHidden', 'Int', '%MW22', true, false],
      ['constant', 'OPN_LIMIT', 'Int', '250', true, true],
    ]);
    expect(t.entries[0]!.comments.get('en-US')?.text).toBe(
      'Start input, exported through Openness',
    );
  });

  it.each(['Tags_IO', 'Tags_Memory'])(
    '%s reads the same from VCI and from an Openness export (C04)',
    (name) => {
      const view = (relative: string) =>
        table(relative).entries.map((e) => ({
          kind: e.kind,
          name: e.name,
          dataType: e.dataType,
          address: e.address,
          value: e.value,
          flags: [e.accessible, e.visible, e.writable, e.retain ?? false],
          comments: [...e.comments]
            .map(([culture, c]) => [culture, c.text])
            .filter(([, text]) => text !== ''),
        }));
      expect(view(`C04-tag-tables/simaticml/${name}.xml`)).toEqual(
        view(`C04-tag-tables/tagtables/${name}.xml`),
      );
    },
  );
});

// TIA has no MAX, MIN or LIMIT in fail-safe LAD (B46): the import is refused, so the case has no
// compile messages for the coverage gate; the checker must still report each box.
describe('instructions unavailable in fail-safe blocks', () => {
  it('reports MAX, MIN and LIMIT in the B46 blocks as errors', async () => {
    const plc = assemblePlcs(all, 'documents').find((p) => p.name === 'PLC_Main')!;
    const diagnostics = await projectChecker(corpusRoot).check(plc);
    expect(
      diagnostics
        .filter((d) => d.ruleId === 'failsafe-instruction')
        .map((d) => `${d.file.objectName}:${d.line} ${d.severity}`)
        .sort(),
    ).toEqual(['F_FC_V3_Limit:20 error', 'F_FC_V3_Max:20 error', 'F_FC_V3_Min:20 error']);
  });
});

// An external source can hold several blocks (C42): TIA writes them one after another, with the
// blocks a block depends on first. Each block counts, also when the documents of the same blocks
// exist: the sources variant loads the source instead of them.
describe('external sources with several blocks (C42)', () => {
  const plc = assemblePlcs(all, 'source').find((p) => p.name === 'PLC_Main')!;
  const { project } = corpusProject(plc, corpusRoot);

  it.each([
    ['Types_V4.udt', ['UDT_V4_Point', 'UDT_V4_Range']],
    ['DBs_V4.db', ['DB_V4_Points', 'DB_V4_Ranges']],
    ['FB_V4_Tally.scl', ['UDT_V4_Counter', 'FC_V4_Advance', 'FB_V4_Tally']],
  ])('%s: every block is in the outline and the index, in file order', (name, blocks) => {
    const file = [...project.files.values()].find((f) => f.path.endsWith(`/${name}`))!;
    expect(file.parsed?.kind).toBe('blocks');
    if (file.parsed?.kind !== 'blocks') return;
    expect(outline(file.parsed).map((o) => o.name)).toEqual(blocks);
    const indexed = project.index.blocks.filter((b) => b.file === file).map((b) => b.name);
    expect(indexed).toEqual(blocks);
  });

  it('loads the sources instead of the documents of the same blocks', () => {
    const v4 = plc.files.filter(
      (f) => f.objectName.includes('_V4_') || f.objectName.endsWith('_V4'),
    );
    expect(v4.map((f) => `${f.variant}/${f.objectName}${f.extension}`).sort()).toEqual([
      'source/DBs_V4.db',
      'source/FB_V4_Tally.scl',
      'source/Types_V4.udt',
    ]);
  });
});

// The demo workspace (npm run demo) is laid out like the owner's projects and shows exactly the
// four showcase errors, one per broken case it includes.
describe('demo workspace', () => {
  const plcs = demoPlcs(corpusRoot);

  it('uses external sources, and SIMATIC SD documents only for LAD/FBD blocks', () => {
    const main = plcs.find((p) => p.name === 'PLC_Main')!;
    expect(main.files.some((f) => f.variant === 'source')).toBe(true);
    const documents = main.files.filter(
      (f) => f.variant === 'documents' && f.extension === '.s7dcl',
    );
    for (const f of documents) {
      const text = readFileSync(f.absolutePath, 'utf8');
      expect(/S7_Language := "(LAD|FBD)"/.test(text), f.objectName).toBe(true);
    }
  });

  it('shows exactly the four showcase errors', async () => {
    const errors: string[] = [];
    for (const plc of plcs) {
      const diagnostics = await projectChecker(corpusRoot).check(plc);
      for (const d of diagnostics.filter((x) => x.severity === 'error'))
        errors.push(`${d.file.objectName} ${d.ruleId}`);
    }
    expect(errors.sort()).toEqual([
      'FB_LadBoxes_B19 missing-box-input',
      'FB_SclCalls_B04 unknown-parameter',
      'FB_SclSections_B01 undeclared-local',
      'FC_SclTypes_B13 recursion',
    ]);
  });
});
