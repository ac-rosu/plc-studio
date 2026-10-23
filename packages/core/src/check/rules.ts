// Every diagnostic PLC Studio reports, with its default severity and whether a corpus case proves
// TIA's behaviour. An error rule without proof reports a warning instead (ADR 0003).

export type RuleCategory =
  'syntax' | 'checker' | 'policy' | 'analyzer' | 'cross-block' | 'naming' | 'project';

export interface RuleInfo {
  readonly id: string;
  readonly category: RuleCategory;
  readonly severity: 'error' | 'warning' | 'info';
  /** Corpus cases that prove the rule; empty = not yet verified against TIA. */
  readonly cases: readonly string[];
  readonly title: string;
}

const r = (
  id: string,
  category: RuleCategory,
  severity: RuleInfo['severity'],
  title: string,
  cases: string[] = [],
): RuleInfo => ({
  id,
  category,
  severity,
  cases,
  title,
});

export const RULES: readonly RuleInfo[] = [
  r('syntax', 'syntax', 'error', 'Syntax error', ['B03', 'B25']),
  r('missing-semicolon', 'syntax', 'error', "Missing ';'", ['B02']),
  r('not-analyzed', 'syntax', 'info', 'Construct kept as it is, not analyzed'),
  r('undeclared-local', 'checker', 'error', 'Undeclared local variable', ['B01']),
  r('unknown-global', 'checker', 'warning', 'Global name not found in the exported files'),
  r('unknown-member', 'checker', 'error', 'Member not found', ['B30']),
  r('unknown-parameter', 'checker', 'error', 'Unknown formal parameter', ['B04']),
  r('missing-inout-parameter', 'checker', 'error', 'Required InOut parameter missing', ['B05']),
  r('missing-fc-parameter', 'checker', 'error', 'FC parameter missing', ['B27', 'B28']),
  r('parameter-direction', 'checker', 'error', "'=>' on an input parameter", ['B29']),
  r('type-mismatch', 'checker', 'error', 'Incompatible data types', [
    'B14',
    'B17',
    'B18',
    'B20',
    'B31',
    'B32',
    'B35',
    'B36',
    'B37',
    'B38',
  ]),
  r('possible-type-mismatch', 'checker', 'warning', 'Data types may be incompatible'),
  r(
    'iec-implicit-conversion',
    'checker',
    'error',
    'Implicit conversion not allowed with the IEC check',
    ['B08', 'B34'],
  ),
  r('implicit-conversion', 'checker', 'warning', 'Implicit conversion may lose data', [
    'B07',
    'C10',
    'C34',
  ]),
  r('assign-to-constant', 'checker', 'error', 'Assignment to a constant', ['B09']),
  r('for-counter-type', 'checker', 'error', 'FOR counter is not an integer', ['B11']),
  r('for-counter-modified', 'checker', 'error', 'FOR counter changed inside the loop', ['B26']),
  r('value-out-of-range', 'checker', 'error', 'Value outside the range of its data type', ['B15']),
  r('not-available-on-cpu', 'checker', 'error', 'Not available on this CPU family', ['B24']),
  r('missing-box-input', 'checker', 'error', 'Required box input not connected', ['B19']),
  r('unpublished-access', 'checker', 'error', 'Access to an unpublished object of another unit', [
    'B21',
  ]),
  r('missing-relation', 'checker', 'error', 'Access to another unit without a relation', ['B22']),
  r('failsafe-type', 'checker', 'error', 'Data type not permitted in a fail-safe block', ['B23']),
  r('failsafe-instruction', 'checker', 'warning', 'Instruction not permitted in a fail-safe block'),
  r('duplicate-case-label', 'checker', 'warning', 'CASE label used twice', ['B10']),
  r('duplicate-name', 'checker', 'error', 'Name declared twice', ['B16']),
  r('exported-twice', 'project', 'warning', 'Block exported in two formats'),
  r('unknown-label', 'checker', 'error', 'Jump to a label that does not exist', ['B33']),
  r(
    'invalid-identifier',
    'naming',
    'info',
    'Identifier with spaces or language-specific characters (TIA accepts it quoted)',
    ['C32'],
  ),
  r(
    'case-only-duplicate',
    'policy',
    'error',
    'Names that differ only by case (PLC Studio rule, ADR 0013)',
    ['B12', 'B16'],
  ),
  r('recursion', 'policy', 'error', 'Recursive call (PLC Studio rule, ADR 0013)', ['B13']),
  r('missing-translation', 'project', 'info', 'Text missing in a language'),
  r('manifest', 'project', 'warning', 'Problem in plc.json'),
];

const byId = new Map(RULES.map((rule) => [rule.id, rule]));

export function ruleInfo(id: string): RuleInfo | undefined {
  return byId.get(id);
}
