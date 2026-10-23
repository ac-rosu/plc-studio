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
import { corePrinter, projectChecker } from './core-adapters.ts';
import { renderReport } from './report.ts';
import { gatesPassed, runGates } from './run.ts';
import { tiaLocation } from './tia-location.ts';

const corpusRoot = fileURLToPath(new URL('../../../corpus', import.meta.url));
const validate = new Ajv({ allErrors: true }).compile(schema);
const versions = corpusVersions(corpusRoot);
const all = versions.flatMap((version) => loadCases(corpusRoot, version));

describe('corpus', () => {
  it('has V21', () => {
    expect(versions).toContain('V21');
  });

  it('V21 has 85 cases: 36 clean, 14 analyzer, 35 broken', () => {
    // 65 from the corpus build, 20 from the verification batch of 2026-10-24
    const v21 = all.filter((c) => c.version === 'V21');
    const count = (kind: string) => v21.filter((c) => c.expected.kind === kind).length;
    expect([v21.length, count('clean'), count('analyzer'), count('broken')]).toEqual([
      85, 36, 14, 35,
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
