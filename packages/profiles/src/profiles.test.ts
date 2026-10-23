import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import schema from '../schema/profile.schema.json' with { type: 'json' };
import { PROFILES } from './index.ts';

const validate = new Ajv({ allErrors: true }).compile(schema);

describe('version profiles', () => {
  it('has a profile for V21', () => {
    expect(Object.keys(PROFILES)).toEqual(['V21']);
  });

  it.each(Object.entries(PROFILES))('profile %s matches the schema', (id, profile) => {
    expect(validate(profile), JSON.stringify(validate.errors)).toBe(true);
    expect(profile.id).toBe(id);
  });

  it('rejects an instruction without verification data', () => {
    const broken = {
      ...PROFILES['V21'],
      instructions: [
        {
          name: 'X',
          parameters: [],
          cpuFamilies: ['S7-1500'],
          failsafeAllowed: false,
          description: 'x',
        },
      ],
    };
    expect(validate(broken)).toBe(false);
  });

  it('rejects a help link that is not https', () => {
    const broken = {
      ...PROFILES['V21'],
      instructions: [
        {
          name: 'X',
          parameters: [],
          cpuFamilies: ['S7-1500'],
          failsafeAllowed: false,
          description: 'x',
          helpUrl: 'http://example.com',
          verification: { verified: false },
        },
      ],
    };
    expect(validate(broken)).toBe(false);
  });
});
