/**
 * Rules that report an error although TIA accepts the code (ADR 0013).
 * Only the owner adds to this list; every entry needs corpus cases that record what TIA does.
 */
export const POLICY_ERROR_RULES = [
  // A block that calls itself, directly or through other blocks. TIA V21 compiles it (corpus B13).
  'recursion',
  // Two identifiers in one scope that differ only by case. TIA refuses them in .s7dcl and
  // renames one silently when importing an external source (corpus B12, B16).
  'case-only-duplicate',
] as const;

export type PolicyErrorRule = (typeof POLICY_ERROR_RULES)[number];

export function isPolicyErrorRule(ruleId: string): ruleId is PolicyErrorRule {
  return (POLICY_ERROR_RULES as readonly string[]).includes(ruleId);
}
