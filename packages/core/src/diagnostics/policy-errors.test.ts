import { describe, expect, it } from 'vitest';
import { POLICY_ERROR_RULES, isPolicyErrorRule } from './policy-errors.ts';

describe('policy errors (ADR 0013)', () => {
  it('lists exactly the rules the owner approved', () => {
    expect(POLICY_ERROR_RULES).toEqual(['recursion', 'case-only-duplicate']);
  });

  it('recognizes policy rules and nothing else', () => {
    expect(isPolicyErrorRule('recursion')).toBe(true);
    expect(isPolicyErrorRule('case-only-duplicate')).toBe(true);
    expect(isPolicyErrorRule('undeclared-identifier')).toBe(false);
    expect(isPolicyErrorRule('Recursion')).toBe(false);
  });
});
