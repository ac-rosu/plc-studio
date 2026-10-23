// Runs every gate over every TIA version and PLC variant of the corpus.
import {
  assemblePlcs,
  corpusVersions,
  loadCases,
  type CorpusCase,
  type PlcVariant,
} from './corpus.ts';
import {
  errorCoverage,
  policyErrorsFound,
  roundTripGate,
  zeroFalseErrorsGate,
  type Checker,
  type CoverageResult,
  type FalseError,
  type PolicyResult,
  type Printer,
  type RoundTripResult,
} from './gates.ts';

export const PLC_VARIANTS: readonly PlcVariant[] = ['documents', 'vci', 'source'];

export interface PlcResult {
  readonly plc: string;
  readonly variant: PlcVariant;
  readonly files: number;
  readonly falseErrors: readonly FalseError[];
  readonly coverage: CoverageResult;
  readonly policy: readonly PolicyResult[];
}

export interface VersionResult {
  readonly version: string;
  readonly cases: readonly CorpusCase[];
  readonly roundTrip: RoundTripResult;
  readonly plcs: readonly PlcResult[];
}

export interface GateRun {
  readonly printer: string;
  readonly checker: string;
  readonly versions: readonly VersionResult[];
}

export async function runGates(
  corpusRoot: string,
  printer: Printer,
  checker: Checker,
): Promise<GateRun> {
  const versions: VersionResult[] = [];
  for (const version of corpusVersions(corpusRoot)) {
    const cases = loadCases(corpusRoot, version);
    const plcs: PlcResult[] = [];
    for (const variant of PLC_VARIANTS) {
      for (const plc of assemblePlcs(cases, variant)) {
        const diagnostics = await checker.check(plc);
        plcs.push({
          plc: plc.name,
          variant,
          files: plc.files.length,
          falseErrors: zeroFalseErrorsGate(plc, diagnostics),
          coverage: errorCoverage(plc, diagnostics),
          policy: policyErrorsFound(plc, diagnostics),
        });
      }
    }
    versions.push({ version, cases, roundTrip: roundTripGate(cases, printer), plcs });
  }
  return { printer: printer.name, checker: checker.name, versions };
}

export function gatesPassed(run: GateRun): boolean {
  return run.versions.every(
    (v) => v.roundTrip.failures.length === 0 && v.plcs.every((p) => p.falseErrors.length === 0),
  );
}
