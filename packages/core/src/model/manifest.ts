// plc.json: what the checker needs and cannot read from the exported files (spec, "PLC folder
// and manifest"). VS Code validates the file against schemas/plc.schema.json; this reader is
// lenient and reports only what affects the project model.
import type { CpuFamily } from '@plcstudio/profiles';
import type { SyntaxDiagnostic } from '../syntax/ast.ts';

export type ObType =
  | 'ProgramCycle'
  | 'CyclicInterrupt'
  | 'TimeOfDay'
  | 'TimeDelay'
  | 'HardwareInterrupt'
  | 'Startup'
  | 'DiagnosticError'
  | 'TimeError'
  | 'ProgrammingError'
  | 'IOAccessError'
  | 'Other';

export interface ObInfo {
  type?: ObType;
  number?: number;
  priority?: number;
  /** Cycle time of a cyclic interrupt OB, in milliseconds. */
  cycleTimeMs?: number;
}

export interface UnitDefinition {
  name: string;
  folder: string;
  namespace: string;
  relations: string[];
  published: string[];
}

export interface Manifest {
  name: string;
  cpu: { family: CpuFamily; failsafe: boolean };
  tiaVersion: string;
  compiler: { iecCheck: boolean };
  displayLanguage: string | undefined;
  /** Project languages; texts missing in one of them are reported. Empty: decided per file. */
  languages: string[];
  units: UnitDefinition[];
  /** OB attributes the exported files do not carry (DECISIONS 2026-10-24). */
  obs: Record<string, ObInfo>;
  /** Names of fail-safe blocks, when the files cannot tell. */
  failsafeBlocks: string[];
  /** Main safety block of each F-runtime group (the exported files do not say). */
  mainSafetyBlocks: string[];
}

export interface ManifestResult {
  manifest: Manifest | undefined;
  diagnostics: SyntaxDiagnostic[];
}

const OB_TYPES = new Set<ObType>([
  'ProgramCycle',
  'CyclicInterrupt',
  'TimeOfDay',
  'TimeDelay',
  'HardwareInterrupt',
  'Startup',
  'DiagnosticError',
  'TimeError',
  'ProgrammingError',
  'IOAccessError',
  'Other',
]);

function problem(
  message: string,
  severity: 'error' | 'warning' = 'warning',
  length = 1,
): SyntaxDiagnostic {
  return { range: { start: 0, end: length }, message, severity, code: 'manifest' };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function parseManifest(text: string): ManifestResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return {
      manifest: undefined,
      diagnostics: [
        problem(
          `plc.json is not valid JSON: ${(e as Error).message}`,
          'warning',
          Math.min(text.length, 1),
        ),
      ],
    };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { manifest: undefined, diagnostics: [problem('plc.json must contain a JSON object.')] };
  }
  const o = json as Record<string, unknown>;
  const diagnostics: SyntaxDiagnostic[] = [];
  const cpu = (o['cpu'] ?? {}) as Record<string, unknown>;
  const family = str(cpu['family']);
  if (family !== 'S7-1200' && family !== 'S7-1500') {
    diagnostics.push(
      problem('plc.json: cpu.family must be "S7-1200" or "S7-1500"; S7-1500 is assumed.'),
    );
  }
  const tiaVersion = str(o['tiaVersion']) ?? 'V21';
  if (tiaVersion !== 'V21')
    diagnostics.push(problem(`plc.json: TIA ${tiaVersion} has no version profile; V21 is used.`));
  const compiler = (o['compiler'] ?? {}) as Record<string, unknown>;
  const units: UnitDefinition[] = [];
  for (const u of Array.isArray(o['units']) ? (o['units'] as unknown[]) : []) {
    const r = (u ?? {}) as Record<string, unknown>;
    const name = str(r['name']);
    const folder = str(r['folder']);
    if (!name || !folder) {
      diagnostics.push(problem('plc.json: every unit needs a name and a folder.'));
      continue;
    }
    units.push({
      name,
      folder,
      namespace: str(r['namespace']) ?? name,
      relations: strings(r['relations']),
      published: strings(r['published']),
    });
  }
  const obs: Record<string, ObInfo> = {};
  const rawObs = (o['obs'] ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(rawObs)) {
    const r = (value ?? {}) as Record<string, unknown>;
    const type = str(r['type']) as ObType | undefined;
    const info: ObInfo = {};
    if (type && OB_TYPES.has(type)) info.type = type;
    if (typeof r['number'] === 'number') info.number = r['number'];
    if (typeof r['priority'] === 'number') info.priority = r['priority'];
    if (typeof r['cycleTimeMs'] === 'number') info.cycleTimeMs = r['cycleTimeMs'];
    obs[name] = info;
  }
  const manifest: Manifest = {
    name: str(o['name']) ?? '',
    cpu: {
      family: family === 'S7-1200' ? 'S7-1200' : 'S7-1500',
      failsafe: cpu['failsafe'] === true,
    },
    tiaVersion: 'V21',
    compiler: { iecCheck: compiler['iecCheck'] === true },
    displayLanguage: str(o['displayLanguage']),
    languages: strings(o['languages']),
    units,
    obs,
    failsafeBlocks: strings(o['failsafeBlocks']),
    mainSafetyBlocks: strings(o['mainSafetyBlocks']),
  };
  diagnostics.push(...relationProblems(units));
  return { manifest, diagnostics };
}

/** Unknown units in relations, and relation rings (TIA does not allow them). */
function relationProblems(units: UnitDefinition[]): SyntaxDiagnostic[] {
  const out: SyntaxDiagnostic[] = [];
  const names = new Set(units.map((u) => u.name));
  for (const u of units) {
    for (const r of u.relations) {
      if (!names.has(r))
        out.push(
          problem(
            `plc.json: unit "${u.name}" has a relation to "${r}", which is not a unit in this manifest.`,
          ),
        );
    }
  }
  const byName = new Map(units.map((u) => [u.name, u]));
  const state = new Map<string, 'visiting' | 'done'>();
  const reported = new Set<string>();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      const ring = [...path.slice(path.indexOf(name)), name].join(' → ');
      if (!reported.has(ring)) {
        reported.add(ring);
        out.push(
          problem(
            `plc.json: the unit relations form a ring (${ring}); TIA does not allow that.`,
            'error',
          ),
        );
      }
      return;
    }
    state.set(name, 'visiting');
    for (const r of byName.get(name)?.relations ?? []) if (byName.has(r)) visit(r, [...path, name]);
    state.set(name, 'done');
  };
  for (const u of units) visit(u.name, []);
  return out;
}

/** A starting manifest for a scanned folder (command "Create manifest"). */
export function proposeManifest(input: {
  name: string;
  family: CpuFamily;
  failsafe: boolean;
  units: { name: string; folder: string; namespace: string }[];
  displayLanguage: string | undefined;
}): string {
  const manifest: Record<string, unknown> = {
    $schema: 'https://raw.githubusercontent.com/ac-rosu/plc-studio/main/schemas/plc.schema.json',
    name: input.name,
    cpu: { family: input.family, failsafe: input.failsafe },
    tiaVersion: 'V21',
    compiler: { iecCheck: false },
  };
  if (input.displayLanguage) manifest['displayLanguage'] = input.displayLanguage;
  if (input.units.length > 0)
    manifest['units'] = input.units.map((u) => ({ ...u, relations: [], published: [] }));
  return JSON.stringify(manifest, null, 2) + '\n';
}
