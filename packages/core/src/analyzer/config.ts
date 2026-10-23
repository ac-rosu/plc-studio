// plcstudio.rules.json: analyzer settings for a workspace or a PLC folder; the PLC folder's file
// wins (spec, "Configuration and custom rules"). VS Code validates the file against
// schemas/rules.schema.json; this reader is lenient and ignores what it does not understand.
import { RULES } from '../check/rules.ts';
import type { SyntaxDiagnostic } from '../syntax/ast.ts';

const RULE_IDS = new Set(RULES.map((r) => r.id));

/** Names the spec uses for rules that have another id here. */
const RULE_ALIASES: Readonly<Record<string, string>> = {
  'timer-called-conditionally': 'timer-not-called-every-cycle',
};

/** The known rule id closest to a misspelt one, if any is close. */
function closestRuleId(id: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(3, Math.floor(id.length / 4)) + 1;
  for (const known of RULE_IDS) {
    const d = editDistance(id, known, bestDistance);
    if (d < bestDistance) [best, bestDistance] = [known, d];
  }
  return best;
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) >= limit) return limit;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

export type RuleSeverity = 'off' | 'info' | 'warning';
export type NamingPreset = 'default' | 'siemens-prefix' | 'match-workspace';
export type ObjectKind = 'OB' | 'FB' | 'FC' | 'DB' | 'UDT' | 'Tag' | 'Constant' | 'Member';

export type CustomRule =
  | {
      id: string;
      kind: 'namePattern';
      target: ObjectKind;
      pattern: string;
      severity: RuleSeverity;
      message?: string;
    }
  | {
      id: string;
      kind: 'forbiddenInstruction';
      instruction: string;
      severity: RuleSeverity;
      message?: string;
    }
  | {
      id: string;
      kind: 'requiredInstruction';
      instruction: string;
      in?: ('OB' | 'FB' | 'FC')[];
      severity: RuleSeverity;
      message?: string;
    }
  | {
      id: string;
      kind: 'complexityLimit';
      maxCyclomatic?: number;
      maxNesting?: number;
      severity: RuleSeverity;
      message?: string;
    }
  | {
      id: string;
      kind: 'forbiddenGlobalAccess';
      in?: ('FB' | 'FC')[];
      severity: RuleSeverity;
      message?: string;
    }
  | {
      id: string;
      kind: 'requiredComment';
      target: ObjectKind;
      severity: RuleSeverity;
      message?: string;
    }
  | {
      id: string;
      kind: 'bannedIdentifier';
      identifiers: string[];
      severity: RuleSeverity;
      message?: string;
    };

export interface FormatOptions {
  /** Casing of SCL keywords: upper (TIA's own), lower, or keep as written. */
  keywordCase: 'upper' | 'lower' | 'preserve';
  /** Spaces per nesting level in SCL code. */
  indentSize: number;
  /** One space around binary operators, ':=' and '=>'; one after commas. */
  spaceAroundOperators: boolean;
  /** Align ':' and ':=' of consecutive declarations, and ':='/'=>' of multi-line calls. */
  alignAssignments: boolean;
}

export const DEFAULT_FORMAT: FormatOptions = {
  keywordCase: 'upper',
  indentSize: 4,
  spaceAroundOperators: true,
  alignAssignments: false,
};

export interface RulesConfig {
  readonly extends: readonly string[];
  readonly rules: ReadonlyMap<
    string,
    { readonly severity: RuleSeverity; readonly options: Readonly<Record<string, unknown>> }
  >;
  readonly naming: NamingPreset | undefined;
  readonly custom: readonly CustomRule[];
  readonly format: FormatOptions;
}

export const DEFAULT_RULES_CONFIG: RulesConfig = {
  extends: ['recommended'],
  rules: new Map(),
  naming: undefined,
  custom: [],
  format: DEFAULT_FORMAT,
};

export interface RulesConfigResult {
  readonly config: Partial<RulesConfigInput>;
  readonly diagnostics: SyntaxDiagnostic[];
}

/** What one file says; merged with the other level afterwards. */
export interface RulesConfigInput {
  extends: string[];
  rules: Map<string, { severity: RuleSeverity; options: Record<string, unknown> }>;
  naming: NamingPreset | undefined;
  custom: CustomRule[];
  format: Partial<FormatOptions>;
}

const SEVERITIES = new Set(['off', 'info', 'warning']);
const PRESETS = new Set(['default', 'siemens-prefix', 'match-workspace']);
const KINDS = new Set([
  'namePattern',
  'forbiddenInstruction',
  'requiredInstruction',
  'complexityLimit',
  'forbiddenGlobalAccess',
  'requiredComment',
  'bannedIdentifier',
]);

function problem(message: string): SyntaxDiagnostic {
  return { range: { start: 0, end: 1 }, message, severity: 'warning', code: 'rules-config' };
}

export function parseRulesConfig(text: string): RulesConfigResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return {
      config: {},
      diagnostics: [problem(`plcstudio.rules.json is not valid JSON: ${(e as Error).message}`)],
    };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      config: {},
      diagnostics: [problem('plcstudio.rules.json must contain a JSON object.')],
    };
  }
  const o = json as Record<string, unknown>;
  const diagnostics: SyntaxDiagnostic[] = [];
  const config: Partial<RulesConfigInput> = {};
  if (Array.isArray(o['extends']))
    config.extends = o['extends'].filter((x): x is string => typeof x === 'string');
  if (o['rules'] && typeof o['rules'] === 'object') {
    const rules = new Map<string, { severity: RuleSeverity; options: Record<string, unknown> }>();
    const customIds = new Set(
      Array.isArray(o['custom'])
        ? (o['custom'] as unknown[]).map((c) => (c as Record<string, unknown> | null)?.['id'])
        : [],
    );
    for (const [written, value] of Object.entries(o['rules'] as Record<string, unknown>)) {
      const id = RULE_ALIASES[written] ?? written;
      if (!RULE_IDS.has(id) && !customIds.has(id)) {
        const near = closestRuleId(id);
        diagnostics.push(
          problem(
            `plcstudio.rules.json: unknown rule "${written}"${near ? `; did you mean "${near}"?` : '.'}`,
          ),
        );
        continue;
      }
      const [sev, options] = Array.isArray(value) ? [value[0], value[1]] : [value, undefined];
      if (typeof sev !== 'string' || !SEVERITIES.has(sev)) {
        diagnostics.push(
          problem(
            `plcstudio.rules.json: rule ${id} needs the severity "off", "info" or "warning"; analyzer rules never report errors.`,
          ),
        );
        continue;
      }
      rules.set(id, {
        severity: sev as RuleSeverity,
        options: options && typeof options === 'object' ? (options as Record<string, unknown>) : {},
      });
    }
    config.rules = rules;
  }
  const naming = (o['naming'] as Record<string, unknown> | undefined)?.['preset'];
  if (typeof naming === 'string') {
    if (PRESETS.has(naming)) config.naming = naming as NamingPreset;
    else diagnostics.push(problem(`plcstudio.rules.json: unknown naming preset "${naming}".`));
  }
  if (Array.isArray(o['custom'])) {
    const custom: CustomRule[] = [];
    for (const raw of o['custom'] as unknown[]) {
      const r = (raw ?? {}) as Record<string, unknown>;
      if (typeof r['id'] !== 'string' || typeof r['kind'] !== 'string' || !KINDS.has(r['kind'])) {
        diagnostics.push(
          problem('plcstudio.rules.json: every custom rule needs an id and a known kind.'),
        );
        continue;
      }
      const severity =
        typeof r['severity'] === 'string' && SEVERITIES.has(r['severity'])
          ? (r['severity'] as RuleSeverity)
          : 'warning';
      custom.push({ ...(r as object), severity } as CustomRule);
    }
    config.custom = custom;
  }
  if (o['format'] && typeof o['format'] === 'object') {
    const f = o['format'] as Record<string, unknown>;
    const format: Partial<FormatOptions> = {};
    if (
      f['keywordCase'] === 'upper' ||
      f['keywordCase'] === 'lower' ||
      f['keywordCase'] === 'preserve'
    )
      format.keywordCase = f['keywordCase'];
    if (typeof f['indentSize'] === 'number' && f['indentSize'] >= 1 && f['indentSize'] <= 8)
      format.indentSize = Math.floor(f['indentSize']);
    if (typeof f['spaceAroundOperators'] === 'boolean')
      format.spaceAroundOperators = f['spaceAroundOperators'];
    if (typeof f['alignAssignments'] === 'boolean') format.alignAssignments = f['alignAssignments'];
    config.format = format;
  }
  return { config, diagnostics };
}

/** The folder's file wins over the workspace's, setting by setting. */
export function mergeRulesConfig(
  workspace: Partial<RulesConfigInput> | undefined,
  folder: Partial<RulesConfigInput> | undefined,
): RulesConfig {
  const rules = new Map<string, { severity: RuleSeverity; options: Record<string, unknown> }>();
  for (const [k, v] of workspace?.rules ?? []) rules.set(k, v);
  for (const [k, v] of folder?.rules ?? []) rules.set(k, v);
  return {
    extends: folder?.extends ?? workspace?.extends ?? ['recommended'],
    rules,
    naming: folder?.naming ?? workspace?.naming,
    custom: folder?.custom ?? workspace?.custom ?? [],
    format: { ...DEFAULT_FORMAT, ...(workspace?.format ?? {}), ...(folder?.format ?? {}) },
  };
}

/** Severity of a rule under a configuration (the rule's default when not configured). */
export function effectiveSeverity(
  config: RulesConfig,
  ruleId: string,
  fallback: 'error' | 'warning' | 'info',
): 'error' | 'warning' | 'info' | 'off' {
  const configured = config.rules.get(ruleId);
  if (!configured) return fallback;
  // errors (TIA rejects the code, or a policy error) cannot be lowered or switched off
  if (fallback === 'error') return 'error';
  return configured.severity;
}

export function ruleOptions(
  config: RulesConfig,
  ruleId: string,
): Readonly<Record<string, unknown>> {
  return config.rules.get(ruleId)?.options ?? {};
}
