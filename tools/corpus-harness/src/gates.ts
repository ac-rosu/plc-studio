// The release gates from docs/SPEC.md ("Quality"), computed over the corpus.
import { isPolicyErrorRule } from '@plcstudio/core';
import { readFileSync } from 'node:fs';
import {
  isParsedFile,
  isTiaClean,
  type CorpusCase,
  type CorpusFile,
  type CorpusPlc,
} from './corpus.ts';
import { matchesLocation, messageLocation, tiaLocation } from './tia-location.ts';

export type Severity = 'error' | 'warning' | 'info';

export interface HarnessDiagnostic {
  readonly file: CorpusFile;
  /** 1-based line in the file. */
  readonly line: number;
  readonly ruleId: string;
  readonly severity: Severity;
  readonly message: string;
}

/** The extension's checker, seen from the harness: diagnostics for a whole PLC. */
export interface Checker {
  readonly name: string;
  check(plc: CorpusPlc): Promise<HarnessDiagnostic[]>;
}

/** Parse, then print an unchanged file. Must give the input bytes back (ADR 0004). */
export interface Printer {
  readonly name: string;
  roundTrip(bytes: Uint8Array, file: CorpusFile): Uint8Array;
}

/**
 * Policy errors (ADR 0013) the extension must report on TIA-clean cases. On these cases the
 * listed rule is expected, so its error is not a false error; anywhere else it is.
 */
export interface PolicyExpectation {
  readonly version: string;
  readonly caseId: string;
  readonly ruleId: string;
  readonly block: string;
}

export const POLICY_EXPECTATIONS: readonly PolicyExpectation[] = [
  { version: 'V21', caseId: 'B13', ruleId: 'recursion', block: 'FC_SclTypes_B13' },
];

// --- Round trip --------------------------------------------------------------------------

export interface RoundTripFailure {
  readonly file: CorpusFile;
  readonly caseFolder: string;
  /** First byte offset where the output differs, or the error the printer threw. */
  readonly problem: string;
}

export interface RoundTripResult {
  readonly checked: number;
  readonly failures: readonly RoundTripFailure[];
}

function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : length;
}

export function roundTripGate(cases: readonly CorpusCase[], printer: Printer): RoundTripResult {
  let checked = 0;
  const failures: RoundTripFailure[] = [];
  for (const corpusCase of cases) {
    for (const file of corpusCase.files.filter(isParsedFile)) {
      checked++;
      const input = new Uint8Array(readFileSync(file.absolutePath));
      try {
        const offset = firstDifference(input, printer.roundTrip(input, file));
        if (offset >= 0) {
          failures.push({
            file,
            caseFolder: corpusCase.folder,
            problem: `differs at byte ${offset}`,
          });
        }
      } catch (error) {
        failures.push({ file, caseFolder: corpusCase.folder, problem: String(error) });
      }
    }
  }
  return { checked, failures };
}

// --- Zero false errors ---------------------------------------------------------------------

export interface FalseError {
  readonly caseFolder: string;
  readonly diagnostic: HarnessDiagnostic;
}

function policyExpected(plc: CorpusPlc, corpusCase: CorpusCase, d: HarnessDiagnostic): boolean {
  return POLICY_EXPECTATIONS.some(
    (p) =>
      p.version === plc.version &&
      p.caseId === corpusCase.expected.caseId &&
      p.ruleId === d.ruleId &&
      p.block === d.file.objectName,
  );
}

/** Errors in files of TIA-clean cases, except the policy errors expected there. */
export function zeroFalseErrorsGate(
  plc: CorpusPlc,
  diagnostics: readonly HarnessDiagnostic[],
): FalseError[] {
  const cases = new Map(plc.cases.map((c) => [c.folder, c]));
  const falseErrors: FalseError[] = [];
  for (const diagnostic of diagnostics.filter((d) => d.severity === 'error')) {
    for (const folder of plc.owners.get(diagnostic.file) ?? []) {
      const corpusCase = cases.get(folder)!;
      if (!isTiaClean(corpusCase)) continue;
      const expected =
        isPolicyErrorRule(diagnostic.ruleId) && policyExpected(plc, corpusCase, diagnostic);
      if (!expected) falseErrors.push({ caseFolder: folder, diagnostic });
    }
  }
  return falseErrors;
}

// --- Error coverage ------------------------------------------------------------------------

export interface CoverageEntry {
  readonly caseFolder: string;
  readonly block: string;
  readonly where: string;
  readonly description: string;
  readonly matched: boolean;
}

export interface CoverageResult {
  readonly expected: number;
  readonly matched: number;
  readonly entries: readonly CoverageEntry[];
}

const describeLocation = (line: number | null, network: number | null) =>
  line !== null ? `line ${line}` : network !== null ? `network ${network}` : 'interface';

/**
 * For every error TIA reported on a broken case: does the extension report an error in the same
 * block, at the same TIA line or network?
 */
export function errorCoverage(
  plc: CorpusPlc,
  diagnostics: readonly HarnessDiagnostic[],
): CoverageResult {
  const texts = new Map<CorpusFile, string>();
  const textOf = (file: CorpusFile) => {
    if (!texts.has(file)) texts.set(file, readFileSync(file.absolutePath, 'utf8'));
    return texts.get(file)!;
  };
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const entries: CoverageEntry[] = [];
  for (const corpusCase of plc.cases.filter((c) => c.expected.compile.state === 'Error')) {
    for (const message of corpusCase.expected.compile.messages.filter(
      (m) => m.severity === 'Error',
    )) {
      const expectedAt = messageLocation(message);
      const matched = errors.some(
        (d) =>
          d.file.objectName === message.block &&
          (plc.owners.get(d.file) ?? []).includes(corpusCase.folder) &&
          matchesLocation(expectedAt, tiaLocation(textOf(d.file), d.line, d.file.extension)),
      );
      entries.push({
        caseFolder: corpusCase.folder,
        block: message.block,
        where: describeLocation(message.line, message.network),
        description: message.description,
        matched,
      });
    }
  }
  return { expected: entries.length, matched: entries.filter((e) => e.matched).length, entries };
}

// --- Policy errors ------------------------------------------------------------------------

export interface PolicyResult {
  readonly expectation: PolicyExpectation;
  readonly found: boolean;
}

export function policyErrorsFound(
  plc: CorpusPlc,
  diagnostics: readonly HarnessDiagnostic[],
): PolicyResult[] {
  const caseIds = new Set(plc.cases.map((c) => c.expected.caseId));
  return POLICY_EXPECTATIONS.filter((p) => p.version === plc.version && caseIds.has(p.caseId)).map(
    (expectation) => ({
      expectation,
      found: diagnostics.some(
        (d) =>
          d.severity === 'error' &&
          d.ruleId === expectation.ruleId &&
          d.file.objectName === expectation.block,
      ),
    }),
  );
}
