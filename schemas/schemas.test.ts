import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import plcSchema from './plc.schema.json' with { type: 'json' };
import rulesSchema from './rules.schema.json' with { type: 'json' };

const ajv = new Ajv({ allErrors: true });
const validatePlc = ajv.compile(plcSchema);
const validateRules = ajv.compile(rulesSchema);

// The examples from docs/SPEC.md.
const SPEC_MANIFEST = {
  $schema: 'https://example.invalid/plc.schema.json',
  name: 'Line3_PLC',
  cpu: { family: 'S7-1500', failsafe: true },
  tiaVersion: 'V21',
  compiler: { iecCheck: true },
  displayLanguage: 'en-US',
  units: [
    {
      name: 'Filling',
      folder: 'Units/Filling',
      namespace: 'Filling',
      relations: ['Dosing'],
      published: ['FB_Filler', 'UDT_FillRecipe'],
    },
  ],
};

const SPEC_RULES = {
  $schema: 'https://example.invalid/rules.schema.json',
  extends: ['recommended'],
  naming: { preset: 'match-workspace' },
  rules: {
    'timer-called-conditionally': 'warning',
    complexity: ['info', { maxCyclomatic: 15, maxNesting: 4 }],
  },
  custom: [
    {
      id: 'no-move-blk-variant',
      kind: 'forbiddenInstruction',
      instruction: 'MOVE_BLK_VARIANT',
      severity: 'warning',
      message: 'Use MOVE_BLK in this project.',
    },
    {
      id: 'motor-fb-name',
      kind: 'namePattern',
      target: 'FB',
      pattern: '^FB_[A-Z][A-Za-z0-9]+$',
      severity: 'info',
    },
  ],
};

const errors = (validate: { errors?: unknown }) => JSON.stringify(validate.errors);

describe('plc.schema.json', () => {
  it("accepts the spec's manifest", () => {
    expect(validatePlc(SPEC_MANIFEST), errors(validatePlc)).toBe(true);
  });

  it('accepts a minimal manifest', () => {
    expect(validatePlc({ name: 'P', cpu: { family: 'S7-1200' }, tiaVersion: 'V21' })).toBe(true);
  });

  it.each([
    ['an unknown CPU family', { ...SPEC_MANIFEST, cpu: { family: 'S7-300' } }],
    ['a TIA version without profile', { ...SPEC_MANIFEST, tiaVersion: 'V19' }],
    ['a misspelled field', { ...SPEC_MANIFEST, tiaversion: 'V21' }],
    ['a unit without namespace', { ...SPEC_MANIFEST, units: [{ name: 'U', folder: 'Units/U' }] }],
    ['a malformed display language', { ...SPEC_MANIFEST, displayLanguage: 'english' }],
  ])('rejects %s', (_label, manifest) => {
    expect(validatePlc(manifest)).toBe(false);
  });
});

describe('rules.schema.json', () => {
  it("accepts the spec's rules file", () => {
    expect(validateRules(SPEC_RULES), errors(validateRules)).toBe(true);
  });

  it.each([
    ['severity error for an analyzer rule', { rules: { 'case-without-else': 'error' } }],
    ['a rule id that is not kebab-case', { rules: { CaseWithoutElse: 'info' } }],
    ['an unknown preset', { naming: { preset: 'hungarian' } }],
    [
      'a name pattern without pattern',
      { custom: [{ id: 'x', kind: 'namePattern', target: 'FB', severity: 'info' }] },
    ],
    ['an unknown custom rule kind', { custom: [{ id: 'x', kind: 'script', severity: 'info' }] }],
  ])('rejects %s', (_label, rules) => {
    expect(validateRules(rules)).toBe(false);
  });
});
