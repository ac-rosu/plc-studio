// Golden-diff tests: every edit operation changes exactly the lines it should (spec M10).
import { profileIndex } from '@plcstudio/profiles';
import { describe, expect, it } from 'vitest';
import { parseResourcesText } from '../formats/s7res.ts';
import { parseBlockText } from '../syntax/parser.ts';
import { applyEdits, changedLines } from '../writer/text-edit.ts';
import {
  addNetwork,
  addParallelBranch,
  connectPin,
  copyNetwork,
  deleteBranch,
  deleteElement,
  deleteNetwork,
  duplicateNetwork,
  elementText,
  insertElement,
  moveElement,
  moveNetwork,
  NEW_OPERAND,
  paletteElement,
  pasteNetwork,
  setNetworkText,
  setOperand,
  type LadderEditOutcome,
  type LadderEditResult,
} from './edit.ts';
import { ladderComponents } from './graph.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

const BLOCK = crlf(
  '{',
  '    S7_Optimized := "TRUE";',
  '    S7_PreferredLanguage := "LAD";',
  '    S7_Version := "0.1"',
  '}',
  'FUNCTION "FC_L" : Void',
  '    VAR_INPUT',
  '        Start : Bool;',
  '        Stop : Bool;',
  '    END_VAR',
  '    VAR_IN_OUT',
  '        Count : Int;',
  '        Motor : Bool;',
  '    END_VAR',
  '',
  '    {',
  '        S7_Language := "LAD";',
  '        S7_NetworkTitle := "MLC_N1T"',
  '    }',
  '    NETWORK', //                         19
  '        RUNG wire#powerrail', //         20
  '            Contact( #Start )', //       21
  '            I_Contact( #Stop )', //      22
  '            Coil( #Motor )', //          23
  '        END_RUNG', //                    24
  '    END_NETWORK', //                     25
  '    { S7_Language := "LAD" }', //        26
  '    NETWORK', //                         27
  '        RUNG wire#powerrail', //         28
  '            Contact( #Start )', //       29
  '            Add(', //                    30
  '                in1 := #Count,', //      31
  '                out => #Count', //       32
  '            )', //                       33
  '        END_RUNG', //                    34
  '    END_NETWORK', //                     35
  'END_FUNCTION', //                        36
);

const RES = parseResourcesText(
  crlf('MultiLingualTexts:', '  - id: MLC_N1T', '    en-US: Motor on'),
);

function ok(outcome: LadderEditOutcome): LadderEditResult {
  if ('error' in outcome) throw new Error(outcome.error);
  return outcome;
}

function apply(outcome: LadderEditOutcome, text = BLOCK): string {
  const after = applyEdits(text, ok(outcome).edits);
  const parsed = parseBlockText(after, 's7dcl');
  expect(parsed.diagnostics, after).toEqual([]);
  return after;
}

const shape = (text: string, network: number) => {
  const n = parseBlockText(text, 's7dcl').blocks[0]!.networks[network - 1]!;
  return ladderComponents(n.ladder!);
};

describe('operands', () => {
  it('replaces one operand on its own line only', () => {
    const start = BLOCK.indexOf('#Start');
    const after = apply(setOperand(BLOCK, start, start + 6, '#Start', '#Enable'));
    expect(changedLines(BLOCK, after)).toEqual([21]);
    expect(after.split('\r\n')[21]).toBe('            Contact( #Enable )');
  });

  it('rejects invalid operands and texts that changed meanwhile', () => {
    const start = BLOCK.indexOf('#Start');
    expect(setOperand(BLOCK, start, start + 6, '#Start', '#a +')).toHaveProperty('error');
    expect(setOperand(BLOCK, start, start + 6, '#Stop', '#a')).toHaveProperty('error');
  });

  it('connects an open input before the outputs', () => {
    const after = apply(connectPin(BLOCK, { network: 2, rung: 0, item: 1 }, 'in2', 'in', '1'));
    expect(changedLines(BLOCK, after)).toEqual([32]);
    expect(after.split('\r\n').slice(31, 35)).toEqual([
      '                in1 := #Count,',
      '                in2 := 1,',
      '                out => #Count',
      '            )',
    ]);
  });
});

describe('elements', () => {
  it('inserts an element as one new line', () => {
    const after = apply(
      insertElement(BLOCK, { network: 1, rung: 0, item: 2 }, { name: 'Contact', operand: '#Stop' }),
    );
    expect(changedLines(BLOCK, after)).toEqual([23]);
    expect(after.split('\r\n')[23]).toBe('            Contact( #Stop )');
  });

  it('inserts at the end of a rung and writes boxes in TIA form', () => {
    const after = apply(
      insertElement(
        BLOCK,
        { network: 1, rung: 0, item: -1 },
        {
          name: 'Move',
          args: [
            { name: 'in', direction: 'in', value: '#Count' },
            { name: 'out1', direction: 'out', value: '#Count' },
          ],
        },
      ),
    );
    expect(changedLines(BLOCK, after)).toEqual([24, 25, 26, 27]);
    expect(after.split('\r\n').slice(24, 28)).toEqual([
      '            Move(',
      '                in := #Count,',
      '                out1 => #Count',
      '            )',
    ]);
  });

  it('deletes an element with its lines', () => {
    const after = apply(deleteElement(BLOCK, { network: 1, rung: 0, item: 1 }));
    expect(after).toBe(BLOCK.replace('            I_Contact( #Stop )\r\n', ''));
  });

  it('refuses to delete the last element of a network', () => {
    const single = BLOCK.replace('            I_Contact( #Stop )\r\n', '').replace(
      '            Contact( #Start )\r\n            Coil',
      '            Coil',
    );
    expect(deleteElement(single, { network: 1, rung: 0, item: 0 })).toHaveProperty('error');
  });

  it('moves an element by swapping two lines', () => {
    const after = apply(moveElement(BLOCK, { network: 1, rung: 0, item: 1 }, -1));
    expect(changedLines(BLOCK, after)).toEqual([21, 22]);
    expect(after.split('\r\n').slice(21, 23)).toEqual([
      '            I_Contact( #Stop )',
      '            Contact( #Start )',
    ]);
  });

  it('moves a multi-line box together with its lines', () => {
    const after = apply(moveElement(BLOCK, { network: 2, rung: 0, item: 1 }, -1));
    expect(changedLines(BLOCK, after)).toEqual([29, 30, 31, 32, 33]);
    expect(after.split('\r\n')[33]).toBe('            Contact( #Start )');
  });
});

describe('branches', () => {
  it('adds a parallel branch inside the network and removes it again exactly', () => {
    const added = apply(addParallelBranch(BLOCK, { network: 1, rung: 0, item: 1 }));
    const lines = changedLines(BLOCK, added);
    expect(Math.min(...lines)).toBeGreaterThanOrEqual(22);
    expect(Math.max(...lines)).toBeLessThanOrEqual(30);
    const tree = shape(added, 1)![0]!.tree;
    expect(tree.kind === 'series' && tree.items.map((i) => i.kind)).toEqual([
      'element',
      'parallel',
      'element',
    ]);
    const removed = apply(deleteBranch(added, 1, 1), added);
    expect(removed).toBe(BLOCK);
  });

  it('opens a branch at a coil (it does not join again)', () => {
    const added = apply(addParallelBranch(BLOCK, { network: 1, rung: 0, item: 2 }));
    const tree = shape(added, 1)![0]!.tree;
    expect(tree.kind === 'series' && tree.items.at(-1)).toMatchObject({
      kind: 'parallel',
      open: true,
    });
  });
});

describe('networks', () => {
  it('adds an empty network before END_FUNCTION', () => {
    const after = applyEdits(BLOCK, ok(addNetwork(BLOCK, 2, 'LAD')).edits);
    expect(changedLines(BLOCK, after)).toEqual([36, 37, 38, 39, 40]);
    expect(parseBlockText(after, 's7dcl').blocks[0]!.networks).toHaveLength(3);
  });

  it('deletes a network with its attribute block', () => {
    const after = apply(deleteNetwork(BLOCK, 2));
    expect(after).toBe(
      BLOCK.split('\r\n')
        .filter((_, i) => i < 26 || i > 35)
        .join('\r\n'),
    );
  });

  it('moves a network by swapping two blocks of lines', () => {
    const after = apply(moveNetwork(BLOCK, 2, -1));
    const nets = parseBlockText(after, 's7dcl').blocks[0]!.networks;
    expect(
      nets[0]!.ladder!.rungs[0]!.items.map((i) => (i.kind === 'element' ? i.instruction : '')),
    ).toEqual(['Contact', 'Add']);
    // only lines of the two networks change (identical lines at the same place stay)
    expect(changedLines(BLOCK, after).every((l) => l >= 15 && l <= 35)).toBe(true);
    expect(after.split('\r\n').slice(0, 15)).toEqual(BLOCK.split('\r\n').slice(0, 15));
  });

  it('duplicates a network with a new title id and copies the texts', () => {
    const result = ok(duplicateNetwork(BLOCK, 1, RES));
    const after = apply(result);
    const nets = parseBlockText(after, 's7dcl').blocks[0]!.networks;
    expect(nets).toHaveLength(3);
    expect(nets[1]!.titleId).not.toBe('MLC_N1T');
    const res = applyEdits(RES.source.text, result.resourceEdits!);
    expect(
      parseResourcesText(res).entries.find((e) => e.id === nets[1]!.titleId)?.values[0]?.text,
    ).toBe('Motor on');
    expect(changedLines(BLOCK, after).every((l) => l >= 26 && l <= 36)).toBe(true);
  });

  it('pastes into another block, re-indented, and reports missing declarations', () => {
    const clip = ok(copyNetwork(BLOCK, 1, RES)).clipboard!;
    const target = crlf(
      'NAMESPACE Unit',
      '    {',
      '        S7_PreferredLanguage := "LAD"',
      '    }',
      '    FUNCTION "FC_T" : Void',
      '        VAR_INPUT',
      '            Start : Bool;',
      '        END_VAR',
      '    END_FUNCTION',
      'END_NAMESPACE',
    );
    const result = ok(pasteNetwork(target, 0, clip, undefined));
    const after = apply(result, target);
    expect(after).toContain(
      '\r\n        NETWORK\r\n            RUNG wire#powerrail\r\n                Contact( #Start )',
    );
    expect(result.missingDeclarations).toEqual(['Stop', 'Motor']);
    expect(result.resourceCreate).toContain('Motor on');
  });
});

describe('titles and comments', () => {
  it('replaces an existing text and adds a language in alphabetical order', () => {
    const replaced = ok(setNetworkText(BLOCK, 1, 'title', 'en-US', 'Motor: on', RES));
    expect(applyEdits(RES.source.text, replaced.resourceEdits!)).toBe(
      crlf('MultiLingualTexts:', '  - id: MLC_N1T', "    en-US: 'Motor: on'"),
    );
    const added = ok(setNetworkText(BLOCK, 1, 'title', 'de-DE', 'Motor ein', RES));
    expect(applyEdits(RES.source.text, added.resourceEdits!)).toBe(
      crlf('MultiLingualTexts:', '  - id: MLC_N1T', '    de-DE: Motor ein', '    en-US: Motor on'),
    );
    expect(replaced.edits).toEqual([]);
  });

  it('gives a network without title a new id in its attribute block only', () => {
    const result = ok(setNetworkText(BLOCK, 2, 'title', 'en-US', 'Count', RES));
    const after = apply(result);
    expect(changedLines(BLOCK, after)).toEqual([26, 27, 28, 29]);
    const net = parseBlockText(after, 's7dcl').blocks[0]!.networks[1]!;
    expect(net.titleId).toMatch(/^MLC_/);
    expect(
      parseResourcesText(applyEdits(RES.source.text, result.resourceEdits!)).entries.at(-1)!.id,
    ).toBe(net.titleId);
  });
});

describe('palette', () => {
  const profile = profileIndex('V21')!;
  it('creates elements in TIA form', () => {
    expect(elementText(paletteElement(profile, 'Contact', 'LAD')!, '    ', '\n')).toBe(
      `    Contact( ${NEW_OPERAND} )\n`,
    );
    expect(elementText(paletteElement(profile, 'Add', 'LAD')!, '', '\n')).toBe(
      `{ S7_Templates := "SrcType := Int" }\nAdd(\n    in1 := ${NEW_OPERAND},\n    in2 := ${NEW_OPERAND},\n    out => ${NEW_OPERAND}\n)\n`,
    );
    expect(paletteElement(profile, 'P_Contact', 'LAD')!.args!.map((a) => a.name)).toEqual([
      'operand',
      'bit',
    ]);
  });
});
