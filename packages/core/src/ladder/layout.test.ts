import { profileIndex } from '@plcstudio/profiles';
import { describe, expect, it } from 'vitest';
import { parseBlockText } from '../syntax/parser.ts';
import { ladderComponents, type LadderTree } from './graph.ts';
import { ladderBlockView } from './model.ts';

const profile = profileIndex('V21')!;
const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

function block(language: 'LAD' | 'FBD', ...networks: string[][]): string {
  return crlf(
    '{',
    `    S7_PreferredLanguage := "${language}"`,
    '}',
    'FUNCTION "FC_X" : Void',
    ...networks.flatMap((body) => [
      `    { S7_Language := "${language}" }`,
      '    NETWORK',
      ...body.map((l) => '        ' + l),
      '    END_NETWORK',
    ]),
    'END_FUNCTION',
  );
}

const show = (t: LadderTree): string =>
  t.kind === 'element'
    ? `${t.element.negated ? '!' : ''}${t.element.instruction}`
    : t.kind === 'series'
      ? `S(${t.items.map(show).join(',')})`
      : `${t.open ? 'O' : 'P'}[${t.items.map(show).join('|')}]`;

function structure(language: 'LAD' | 'FBD', body: string[]): string | undefined {
  const file = parseBlockText(block(language, body), 's7dcl');
  expect(file.diagnostics).toEqual([]);
  return ladderComponents(file.blocks[0]!.networks[0]!.ladder!)
    ?.map((c) => `${c.source.kind}:${show(c.tree)}`)
    .join(' ; ');
}

describe('series-parallel structure', () => {
  it('reads a simple rung as a series', () => {
    expect(
      structure('LAD', [
        'RUNG wire#powerrail',
        '    Contact( #a )',
        '    I_Contact( #b )',
        '    Coil( #c )',
        'END_RUNG',
      ]),
    ).toBe('powerrail:S(Contact,I_Contact,Coil)');
  });

  it('reads nested parallel branches that join again (C16 network 8)', () => {
    expect(
      structure('LAD', [
        'RUNG wire#powerrail',
        '    Contact( #a )',
        '    wire#w1',
        '    I_Contact( #b )',
        '    Coil( #c )',
        'END_RUNG',
        'RUNG wire#powerrail',
        '    Contact( #d )',
        '    wire#w2',
        '    Contact( #e )',
        'END_RUNG wire#w1',
        'RUNG wire#w2',
        '    Contact( #f )',
        'END_RUNG wire#w1',
      ]),
    ).toBe('powerrail:S(P[Contact|S(Contact,P[Contact|Contact])],I_Contact,Coil)');
  });

  it('reads branches that end at their own coils as open (C18)', () => {
    expect(
      structure('LAD', [
        'RUNG wire#powerrail',
        '    Contact( #a )',
        '    wire#w1',
        '    Coil( #x )',
        'END_RUNG',
        'RUNG wire#w1',
        '    Coil( #y )',
        'END_RUNG',
      ]),
    ).toBe('powerrail:S(Contact,O[Coil|Coil])');
  });

  it('reads FBD rungs that start at an operand', () => {
    expect(
      structure('FBD', [
        'RUNG #a',
        '    O( in2 := #b )',
        '    NOT A( in2 := #c )',
        '    Coil( #d )',
        'END_RUNG',
      ]),
    ).toBe('operand:S(O,!A,Coil)');
  });

  it('gives up on rungs that do not form a series-parallel structure', () => {
    // a bridge: w1 → w2 crosses between two parallel paths
    expect(
      structure('LAD', [
        'RUNG wire#powerrail',
        '    Contact( #a )',
        '    wire#w1',
        '    Contact( #b )',
        '    wire#w3',
        '    Coil( #x )',
        'END_RUNG',
        'RUNG wire#powerrail',
        '    Contact( #c )',
        '    wire#w2',
        '    Contact( #d )',
        'END_RUNG wire#w3',
        'RUNG wire#w1',
        '    Contact( #e )',
        'END_RUNG wire#w2',
      ]),
    ).toBeUndefined();
  });
});

describe('block view', () => {
  it('draws LAD, keeps SCL networks as text and falls back on broken networks', () => {
    const text = crlf(
      '{',
      '    S7_PreferredLanguage := "LAD"',
      '}',
      'FUNCTION "FC_X" : Void',
      '    { S7_Language := "LAD" }',
      '    NETWORK',
      '        RUNG wire#powerrail',
      '            Contact( #a )',
      '            Coil( #b )',
      '        END_RUNG',
      '    END_NETWORK',
      '    { S7_Language := "SCL" }',
      '    NETWORK',
      '        ',
      '            #b := #a;',
      '        ',
      '    END_NETWORK',
      '    { S7_Language := "LAD" }',
      '    NETWORK',
      '        RUNG wire#powerrail',
      '            Contact( #a',
      '        END_RUNG',
      '    END_NETWORK',
      'END_FUNCTION',
    );
    const view = ladderBlockView(parseBlockText(text, 's7dcl'), { profile })!;
    expect(view.networks.map((n) => n.kind)).toEqual(['drawn', 'text', 'fallback']);
    expect(view.networks[1]!.text).toBe('#b := #a;');
    expect(view.networks[2]!.reason).toMatch(/syntax error/);
    const [contact, coil] = view.networks[0]!.layout!.elements;
    expect([contact!.shape, contact!.operand?.text, coil!.shape]).toEqual([
      'contact',
      '#a',
      'coil',
    ]);
    expect(contact!.lineY).toBe(coil!.lineY);
    expect(coil!.x).toBeGreaterThanOrEqual(contact!.x + contact!.w);
  });

  it('lays out a 100-network block well under one second', () => {
    const networks = Array.from({ length: 100 }, (_, i) => [
      'RUNG wire#powerrail',
      `    Contact( #a${i} )`,
      '    wire#w1',
      `    I_Contact( #b${i} )`,
      '    { S7_Templates := "time_type := Time" }',
      `    #T${i}.TON(`,
      '        pt := T#1s,',
      `        et => #e${i}`,
      '    )',
      `    Coil( #c${i} )`,
      'END_RUNG',
      'RUNG wire#powerrail',
      `    Contact( #d${i} )`,
      'END_RUNG wire#w1',
    ]);
    const text = block('LAD', ...networks);
    const t0 = Date.now();
    const view = ladderBlockView(parseBlockText(text, 's7dcl'), { profile })!;
    const ms = Date.now() - t0;
    expect(view.networks.every((n) => n.kind === 'drawn')).toBe(true);
    expect(ms).toBeLessThan(500);
  });
});
