import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import schema from '../schema/profile.schema.json' with { type: 'json' };
import { PROFILES, RAW_PROFILES, parseSignature, profileIndex } from './index.ts';

const validate = new Ajv({ allErrors: true }).compile(schema);

describe('version profiles', () => {
  it('has a profile for V21', () => {
    expect(Object.keys(PROFILES)).toEqual(['V21']);
  });

  it.each(Object.entries(RAW_PROFILES))('profile %s matches the schema', (id, raw) => {
    expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
    expect(PROFILES[id]!.id).toBe(id);
  });

  it('rejects an instruction without verification data', () => {
    const raw = RAW_PROFILES['V21'] as { instructions: unknown[] };
    const broken = {
      ...raw,
      instructions: [
        {
          name: 'X',
          kind: 'function',
          parameters: [],
          cpuFamilies: ['S7-1500'],
          failsafeAllowed: false,
          description: 'x',
        },
      ],
    };
    expect(validate(broken)).toBe(false);
  });

  it('rejects a malformed parameter signature', () => {
    const raw = RAW_PROFILES['V21'] as { instructions: unknown[] };
    const broken = {
      ...raw,
      instructions: [
        {
          name: 'X',
          kind: 'function',
          parameters: ['input IN Bool'],
          cpuFamilies: ['S7-1500'],
          failsafeAllowed: false,
          description: 'x',
          verification: { verified: false },
        },
      ],
    };
    expect(validate(broken)).toBe(false);
  });

  it('expands signatures', () => {
    expect(parseSignature('in in1: Bool?')).toEqual({
      direction: 'in',
      name: 'in1',
      type: 'Bool',
      optional: true,
    });
    expect(parseSignature('out ET: Time')).toEqual({
      direction: 'out',
      name: 'ET',
      type: 'Time',
      optional: false,
    });
  });

  it('looks up types, literals, instructions and conversions case-insensitively', () => {
    const p = profileIndex('V21')!;
    expect(p.elementary('tod')?.name).toBe('Time_Of_Day');
    expect(p.literalType('LT')?.name).toBe('LTime');
    expect(p.literalType('lt')?.cpuFamilies).toEqual(['S7-1500']);
    expect(p.instruction('ton')?.parameters.map((x) => x.name)).toEqual(['IN', 'PT', 'Q', 'ET']);
    expect(p.systemType('TON_TIME')?.instruction).toBe('TON');
    expect(p.conversion('INT_TO_REAL')).toMatchObject({
      from: { name: 'Int' },
      to: { name: 'Real' },
    });
    expect(p.conversion('LTIME_TO_DINT')?.from.cpuFamilies).toEqual(['S7-1500']);
    expect(p.ladderElement('contact')?.shape).toBe('contact');
  });

  it('marks as verified only entries backed by corpus cases', () => {
    const p = PROFILES['V21']!;
    const entries = [
      ...p.elementaryTypes,
      ...p.systemTypes,
      ...p.instructions,
      ...p.ladderElements,
    ];
    for (const e of entries) {
      if (e.verification.verified) expect(e.verification.cases?.length, e.name).toBeGreaterThan(0);
    }
  });
});
