import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assemblePlcs, loadCases, type CorpusPlc } from './corpus.ts';
import type { ExpectedCase } from './expected.ts';
import {
  errorCoverage,
  policyErrorsFound,
  roundTripGate,
  zeroFalseErrorsGate,
  type HarnessDiagnostic,
  type Printer,
} from './gates.ts';

const root = mkdtempSync(path.join(tmpdir(), 'plcstudio-harness-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SCL_DOC = (name: string) =>
  [
    '{',
    '    S7_EditorMode := "SCL"',
    '}',
    `FUNCTION ${name} : Void`,
    '    NETWORK',
    '        ',
    '        #a := 1;',
    '    END_NETWORK',
    'END_FUNCTION',
    '',
  ].join('\r\n');

function writeCase(folder: string, expected: Partial<ExpectedCase>, files: Record<string, string>) {
  const directory = path.join(root, 'V21', folder);
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
    writeFileSync(path.join(directory, relative), text);
  }
  const full: ExpectedCase = {
    caseId: folder.split('-')[0]!,
    title: folder,
    kind: 'clean',
    basedOn: null,
    tiaVersion: 'V21',
    plc: 'PLC_Test',
    cpu: 'OrderNumber:x',
    objects: [],
    exports: { documents: Object.keys(files), refused: {} },
    compile: { state: 'Success', errors: 0, warnings: 0, messages: [], sources: [] },
    intendedError: null,
    analyzerExpect: [],
    notes: '',
    ...expected,
  };
  writeFileSync(path.join(directory, 'expected.json'), JSON.stringify(full));
}

writeCase(
  'C01-clean',
  {},
  { 'documents/FC_A.s7dcl': SCL_DOC('FC_A'), 'documents/IDB_Shared.s7dcl': 'DATA_BLOCK\r\n' },
);
writeCase('C02-shares', {}, { 'documents/IDB_Shared.s7dcl': 'DATA_BLOCK\r\n' });
writeCase('B13-recursion', {}, { 'documents/FC_SclTypes_B13.s7dcl': SCL_DOC('FC_SclTypes_B13') });
writeCase(
  'B01-broken',
  {
    kind: 'broken',
    compile: {
      state: 'Error',
      errors: 1,
      warnings: 0,
      sources: [],
      messages: [
        {
          severity: 'Error',
          path: 'PLC_Test > FC_B (FC2)',
          block: 'FC_B',
          line: 2,
          network: null,
          description: 'bad',
        },
      ],
    },
  },
  { 'documents/FC_B.s7dcl': SCL_DOC('FC_B') },
);

const cases = loadCases(root, 'V21');
const plc: CorpusPlc = assemblePlcs(cases, 'documents')[0]!;
const fileOf = (name: string) => plc.files.find((f) => f.objectName === name)!;
const diagnostic = (
  name: string,
  line: number,
  ruleId: string,
  severity: HarnessDiagnostic['severity'] = 'error',
): HarnessDiagnostic => ({
  file: fileOf(name),
  line,
  ruleId,
  severity,
  message: ruleId,
});

describe('assemblePlcs', () => {
  it('loads an object shared by two cases once, owned by both', () => {
    expect(plc.files.filter((f) => f.objectName === 'IDB_Shared')).toHaveLength(1);
    expect(plc.owners.get(fileOf('IDB_Shared'))).toEqual(['C01-clean', 'C02-shares']);
  });
});

describe('zeroFalseErrorsGate', () => {
  it('flags errors on TIA-clean cases, also in shared files once per owning case', () => {
    const falseErrors = zeroFalseErrorsGate(plc, [
      diagnostic('FC_A', 7, 'some-rule'),
      diagnostic('IDB_Shared', 1, 'x'),
    ]);
    expect(falseErrors.map((f) => f.caseFolder)).toEqual(['C01-clean', 'C01-clean', 'C02-shares']);
  });

  it('ignores warnings, info and errors on broken cases', () => {
    expect(
      zeroFalseErrorsGate(plc, [
        diagnostic('FC_A', 7, 'w', 'warning'),
        diagnostic('FC_A', 7, 'i', 'info'),
        diagnostic('FC_B', 7, 'e'),
      ]),
    ).toEqual([]);
  });

  it('exempts a policy error only where it is expected (ADR 0013)', () => {
    expect(zeroFalseErrorsGate(plc, [diagnostic('FC_SclTypes_B13', 7, 'recursion')])).toEqual([]);
    expect(zeroFalseErrorsGate(plc, [diagnostic('FC_A', 7, 'recursion')])).toHaveLength(1);
    expect(
      zeroFalseErrorsGate(plc, [diagnostic('FC_SclTypes_B13', 7, 'case-only-duplicate')]),
    ).toHaveLength(1);
  });
});

describe('errorCoverage', () => {
  it("matches an error at TIA's line in the same block", () => {
    const result = errorCoverage(plc, [diagnostic('FC_B', 7, 'e')]);
    expect(result).toMatchObject({ expected: 1, matched: 1 });
  });

  it('does not match another line, a warning or another block', () => {
    expect(errorCoverage(plc, [diagnostic('FC_B', 6, 'e')]).matched).toBe(0);
    expect(errorCoverage(plc, [diagnostic('FC_B', 7, 'w', 'warning')]).matched).toBe(0);
    expect(errorCoverage(plc, [diagnostic('FC_A', 7, 'e')]).matched).toBe(0);
  });
});

describe('policyErrorsFound', () => {
  it('reports expected policy errors as found or missing', () => {
    expect(policyErrorsFound(plc, []).map((r) => r.found)).toEqual([false]);
    expect(
      policyErrorsFound(plc, [diagnostic('FC_SclTypes_B13', 7, 'recursion')]).map((r) => r.found),
    ).toEqual([true]);
  });
});

describe('roundTripGate', () => {
  const identity: Printer = { name: 'identity', roundTrip: (bytes) => bytes };
  const dropLastByte: Printer = {
    name: 'lossy',
    roundTrip: (bytes) => bytes.subarray(0, bytes.length - 1),
  };

  it('passes an identical print and reports where a lossy one differs', () => {
    expect(roundTripGate(cases, identity).failures).toEqual([]);
    const failures = roundTripGate(cases, dropLastByte).failures;
    expect(failures.length).toBe(roundTripGate(cases, identity).checked);
    expect(failures[0]?.problem).toMatch(/^differs at byte \d+$/);
  });
});
