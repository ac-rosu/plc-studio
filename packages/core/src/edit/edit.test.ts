// Golden diffs for every edit operation: exact output text and only the expected lines changed.
import { profileIndex } from '@plcstudio/profiles';
import { describe, expect, it } from 'vitest';
import { parseResourcesText } from '../formats/s7res.ts';
import { parseTagTableText } from '../formats/tag-table.ts';
import { parseBlockText } from '../syntax/parser.ts';
import { applyEdits, changedLines } from '../writer/text-edit.ts';
import { lineDiffEdits, type EditResult } from './common.ts';
import {
  addMember,
  deleteMember,
  findMember,
  memberComment,
  memberFlags,
  moveMember,
  retypeMember,
  setDefaultValue,
  setMemberComment,
  setMemberFlags,
  setReturnType,
} from './declarations.ts';
import {
  addResourceEntry,
  newResourceFileText,
  removeResourceEntry,
  setResourceText,
} from './resources.ts';
import { setStartValue, startValueText, validateStartValue } from './start-values.ts';
import {
  addEntry,
  addressProblems,
  csvChanges,
  csvImport,
  deleteEntry,
  exportCsv,
  findEntry,
  nextCsvEdit,
  parseAddress,
  renameEntryText,
  setConstantValue,
  setEntryAddress,
  setEntryComment,
  setEntryDataType,
  setEntryFlag,
} from './tag-table.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

const SD_FB = crlf(
  '{',
  '    S7_EditorMode := "SCL";',
  '    S7_Version := "0.1"',
  '}',
  'FUNCTION_BLOCK "FB_X"',
  '    VAR_INPUT',
  '        { S7_MLC := "MLC_I1" }',
  '        Enable : Bool;',
  '        Mode : Int;',
  '    END_VAR',
  '    VAR',
  '        State : Int;',
  '    END_VAR',
  '',
  '    { S7_Language := "SCL" }',
  '    NETWORK',
  '        ',
  '            #State := #Mode;',
  '        ',
  '    END_NETWORK',
  'END_FUNCTION_BLOCK',
);

const RES = crlf(
  'MultiLingualTexts:',
  '  - id: MLC_I1',
  '    de-DE: Freigabe',
  '    en-US: Enable it',
);

const SRC_DB = crlf(
  '﻿DATA_BLOCK "DB_M"',
  "{ S7_Optimized_Access := 'TRUE' }",
  'VERSION : 0.1',
  'NON_RETAIN',
  '   VAR ',
  '      MachineOn : Bool;   // Machine switched on',
  "      Speed { S7_SetPoint := 'True'} : Real;   // Speed setpoint",
  '      Count : Int;',
  '   END_VAR',
  '   VAR RETAIN',
  '      Hours : DInt;   // Operating hours',
  '   END_VAR',
  '',
  '',
  'BEGIN',
  '   MachineOn := FALSE;',
  '   Count := 0;',
  '',
  'END_DATA_BLOCK',
  '',
);

const SD_DB = crlf(
  '{',
  '    S7_Optimized := "TRUE";',
  '    S7_StandardRetain := "FALSE";',
  '    S7_Version := "0.1"',
  '}',
  'DATA_BLOCK DB_M',
  '    VAR',
  '        { S7_MLC := "MLC_1" }',
  '        MachineOn : Bool;',
  '        {',
  '            S7_MLC := "MLC_2";',
  '            S7_Setpoint := "True"',
  '        }',
  '        Speed : Real;',
  '    END_VAR',
  '',
  '    MachineOn := FALSE;',
  '    Speed := 1.5;',
  '',
  'END_DATA_BLOCK',
);

function apply(text: string, result: EditResult): string {
  expect(result.error).toBeUndefined();
  return applyEdits(text, result.edits);
}

function golden(text: string, result: EditResult, expected: string, lines: number[]) {
  const after = apply(text, result);
  expect(after).toBe(expected);
  expect(changedLines(text, after)).toEqual(lines);
}

const sdCtx = (text = SD_FB, res = RES) => {
  const file = parseBlockText(text, 's7dcl');
  return { file, block: file.blocks[0]!, resources: parseResourcesText(res) };
};
const srcCtx = (text = SRC_DB) => {
  const file = parseBlockText(text, 'source');
  return { file, block: file.blocks[0]! };
};

describe('interface edits in SIMATIC SD documents', () => {
  it('adds a member with a comment: attribute line in the document, entry in the .s7res', () => {
    const ctx = sdCtx();
    const r = addMember(
      ctx,
      'Input',
      { name: 'Speed', type: 'Real', initial: '1.0', comment: 'Target speed' },
      { culture: 'en-US' },
    );
    const id = /S7_MLC := "([^"]+)"/.exec(r.edits[0]!.newText)![1]!;
    golden(
      SD_FB,
      r,
      SD_FB.replace(
        '        Mode : Int;\r\n',
        `        Mode : Int;\r\n        { S7_MLC := "${id}" }\r\n        Speed : Real := 1.0;\r\n`,
      ),
      [9, 10],
    );
    expect(applyEdits(RES, r.resourceEdits!)).toBe(
      RES + `  - id: ${id}\r\n    en-US: Target speed\r\n`,
    );
  });

  it('adds a missing section in TIA order', () => {
    const r = addMember(sdCtx(), 'Temp', { name: 'i', type: 'Int' });
    golden(
      SD_FB,
      r,
      SD_FB.replace(
        '        State : Int;\r\n    END_VAR\r\n',
        '        State : Int;\r\n    END_VAR\r\n    VAR_TEMP\r\n        i : Int;\r\n    END_VAR\r\n',
      ),
      [13, 14, 15],
    );
  });

  it('refuses a duplicate or invalid name', () => {
    expect(addMember(sdCtx(), 'Static', { name: 'mode', type: 'Int' }).error).toMatch(
      /already declared/,
    );
    expect(addMember(sdCtx(), 'Static', { name: 'a b', type: 'Int' }).error).toMatch(
      /not a valid name/,
    );
  });

  it('deletes a member with its attribute line and its .s7res entry', () => {
    const ctx = sdCtx();
    const r = deleteMember(ctx, ['Enable']);
    golden(
      SD_FB,
      r,
      SD_FB.replace('        { S7_MLC := "MLC_I1" }\r\n        Enable : Bool;\r\n', ''),
      [6],
    );
    expect(applyEdits(RES, r.resourceEdits!)).toBe('MultiLingualTexts:\r\n');
  });

  it('moves a member down and up', () => {
    const down = moveMember(sdCtx(), ['Enable'], 1);
    golden(
      SD_FB,
      down,
      SD_FB.replace(
        '        { S7_MLC := "MLC_I1" }\r\n        Enable : Bool;\r\n        Mode : Int;\r\n',
        '        Mode : Int;\r\n        { S7_MLC := "MLC_I1" }\r\n        Enable : Bool;\r\n',
      ),
      [6, 7, 8],
    );
    expect(moveMember(sdCtx(), ['Enable'], -1).error).toMatch(/edge/);
  });

  it('retypes and sets, changes and removes a default value', () => {
    golden(
      SD_FB,
      retypeMember(sdCtx(), ['Mode'], 'DInt'),
      SD_FB.replace('Mode : Int;', 'Mode : DInt;'),
      [8],
    );
    const withDefault = apply(SD_FB, setDefaultValue(sdCtx(), ['Mode'], '3'));
    expect(withDefault).toBe(SD_FB.replace('Mode : Int;', 'Mode : Int := 3;'));
    const changed = apply(withDefault, setDefaultValue(sdCtx(withDefault), ['Mode'], '4'));
    expect(changed).toBe(SD_FB.replace('Mode : Int;', 'Mode : Int := 4;'));
    expect(apply(changed, setDefaultValue(sdCtx(changed), ['Mode'], undefined))).toBe(SD_FB);
  });

  it('writes HMI flags and setpoint as TIA does: sorted attribute block', () => {
    const r = setMemberFlags(sdCtx(), ['Enable'], { writable: false, setpoint: true });
    golden(
      SD_FB,
      r,
      SD_FB.replace(
        '        { S7_MLC := "MLC_I1" }\r\n',
        '        {\r\n            S7_Access := "ReadOnly := External";\r\n            S7_MLC := "MLC_I1";\r\n            S7_Setpoint := "True"\r\n        }\r\n',
      ),
      [6, 7, 8, 9, 10],
    );
    const hidden = apply(SD_FB, setMemberFlags(sdCtx(), ['Mode'], { accessible: false }));
    expect(hidden).toContain(
      '        {\r\n            S7_Access := "ReadOnly := External";\r\n            S7_Visibility := "Hidden := External"\r\n        }\r\n        Mode : Int;',
    );
    const ctx = sdCtx(hidden);
    expect(memberFlags(ctx, findMember(ctx.block, ['Mode'])!)).toMatchObject({
      accessible: false,
      visible: false,
      writable: false,
    });
    expect(
      apply(
        hidden,
        setMemberFlags(ctx, ['Mode'], { accessible: true, visible: true, writable: true }),
      ),
    ).toBe(SD_FB);
  });

  it('edits a comment in the .s7res, or gives the member a new id', () => {
    const ctx = sdCtx();
    expect(memberComment(ctx, findMember(ctx.block, ['Enable'])!.member, 'de-DE')).toBe('Freigabe');
    const existing = setMemberComment(ctx, ['Enable'], 'de-DE', 'Freigabe: Start');
    expect(existing.edits).toEqual([]);
    expect(applyEdits(RES, existing.resourceEdits!)).toBe(
      RES.replace('de-DE: Freigabe', "de-DE: 'Freigabe: Start'"),
    );
    const fresh = setMemberComment(ctx, ['Mode'], 'en-US', 'Operating mode');
    const id = /S7_MLC := "([^"]+)"/.exec(fresh.edits[0]!.newText)![1]!;
    golden(
      SD_FB,
      fresh,
      SD_FB.replace('        Mode : Int;', `        { S7_MLC := "${id}" }\r\n        Mode : Int;`),
      [8],
    );
    expect(applyEdits(RES, fresh.resourceEdits!)).toBe(
      RES + `  - id: ${id}\r\n    en-US: Operating mode\r\n`,
    );
  });

  it('creates a .s7res when the block has none', () => {
    const file = parseBlockText(SD_FB, 's7dcl');
    const r = setMemberComment({ file, block: file.blocks[0]! }, ['Mode'], 'en-US', 'Mode');
    expect(r.newResourceText).toMatch(
      /^MultiLingualTexts:\r\n {2}- id: MLC_\w+\r\n {4}en-US: Mode\r\n$/,
    );
  });

  it('adds a member to a UDT', () => {
    const udt = crlf(
      'TYPE',
      '    UDT_M : STRUCT',
      '        On : Bool;',
      '    END_STRUCT;',
      'END_TYPE',
    );
    const file = parseBlockText(udt, 's7dcl');
    golden(
      udt,
      addMember({ file, block: file.blocks[0]! }, 'Static', { name: 'Speed', type: 'Real' }),
      udt.replace('        On : Bool;\r\n', '        On : Bool;\r\n        Speed : Real;\r\n'),
      [3],
    );
  });
});

describe('members inside structs and the return type of functions', () => {
  const SD_STRUCT = crlf(
    '{',
    '    S7_Optimized := "TRUE";',
    '    S7_Version := "0.1"',
    '}',
    'DATA_BLOCK DB_S',
    '    VAR',
    '        { S7_MLC := "MLC_1" }',
    '        Limits : STRUCT',
    '            Minimum : Real;',
    '            Inner : STRUCT',
    '            END_STRUCT;',
    '        END_STRUCT;',
    '    END_VAR',
    '',
    'END_DATA_BLOCK',
  );
  const SRC_STRUCT = crlf(
    'DATA_BLOCK "DB_S"',
    "{ S7_Optimized_Access := 'TRUE' }",
    'VERSION : 0.1',
    'NON_RETAIN',
    '   VAR ',
    '      Limits : Struct   // Process limits',
    '         Minimum : Real;   // Lower limit',
    '      END_STRUCT;',
    '   END_VAR',
    '',
    '',
    'BEGIN',
    '',
    'END_DATA_BLOCK',
  );
  const sd = (text = SD_STRUCT) => {
    const file = parseBlockText(text, 's7dcl');
    return { file, block: file.blocks[0]! };
  };
  const src = (text = SRC_STRUCT) => {
    const file = parseBlockText(text, 'source');
    return { file, block: file.blocks[0]! };
  };

  it('adds a member at the end of a struct, with the indent of its members (SIMATIC SD)', () => {
    golden(
      SD_STRUCT,
      addMember(sd(), 'Static', { name: 'Maximum', type: 'Real' }, { parent: ['Limits'] }),
      SD_STRUCT.replace(
        '            END_STRUCT;\r\n        END_STRUCT;',
        '            END_STRUCT;\r\n            Maximum : Real;\r\n        END_STRUCT;',
      ),
      [11],
    );
  });

  it('adds into an empty nested struct, one level deeper than its END_STRUCT', () => {
    golden(
      SD_STRUCT,
      addMember(sd(), 'Static', { name: 'Low', type: 'Int' }, { parent: ['Limits', 'Inner'] }),
      SD_STRUCT.replace(
        '            Inner : STRUCT\r\n',
        '            Inner : STRUCT\r\n                Low : Int;\r\n',
      ),
      [10],
    );
  });

  it('adds a Struct member with its empty body, and after a given nested member', () => {
    golden(
      SD_STRUCT,
      addMember(
        sd(),
        'Static',
        { name: 'Range', type: 'Struct' },
        { parent: ['Limits'], after: ['Limits', 'Minimum'] },
      ),
      SD_STRUCT.replace(
        '            Minimum : Real;\r\n',
        '            Minimum : Real;\r\n            Range : STRUCT\r\n            END_STRUCT;\r\n',
      ),
      [9, 10],
    );
  });

  it('checks names per struct and refuses a parent that is not a struct', () => {
    expect(
      addMember(sd(), 'Static', { name: 'minimum', type: 'Int' }, { parent: ['Limits'] }).error,
    ).toMatch(/already declared in this struct/);
    expect(
      addMember(sd(), 'Static', { name: 'X', type: 'Int' }, { parent: ['Limits', 'Minimum'] })
        .error,
    ).toMatch(/not a Struct/);
    // a name used inside a struct is free at the top level
    expect(addMember(sd(), 'Static', { name: 'Minimum', type: 'Int' }).error).toBeUndefined();
  });

  it('adds nested members in external sources, comment at the end of the line', () => {
    golden(
      SRC_STRUCT,
      addMember(
        src(),
        'Static',
        { name: 'Maximum', type: 'Real', comment: 'Upper limit' },
        { parent: ['Limits'] },
      ),
      SRC_STRUCT.replace(
        '      END_STRUCT;',
        '         Maximum : Real;   // Upper limit\r\n      END_STRUCT;',
      ),
      [7],
    );
    golden(
      SRC_STRUCT,
      addMember(
        src(),
        'Static',
        { name: 'Range', type: 'struct', comment: 'r' },
        { parent: ['Limits'] },
      ),
      SRC_STRUCT.replace(
        '      END_STRUCT;',
        '         Range : Struct   // r\r\n         END_STRUCT;\r\n      END_STRUCT;',
      ),
      [7, 8],
    );
  });

  it('adding and deleting a nested member gives the file back', () => {
    const added = apply(
      SD_STRUCT,
      addMember(sd(), 'Static', { name: 'Maximum', type: 'Real' }, { parent: ['Limits'] }),
    );
    expect(apply(added, deleteMember(sd(added), ['Limits', 'Maximum']))).toBe(SD_STRUCT);
  });

  it('changes the return type of a function in both formats', () => {
    const sdFc = crlf(
      '{',
      '    S7_EditorMode := "SCL";',
      '    S7_Optimized := "TRUE";',
      '    S7_Version := "0.1"',
      '}',
      'FUNCTION "FC_X" : Void',
      '    VAR_INPUT',
      '        a : Int;',
      '    END_VAR',
      '',
      '    { S7_Language := "SCL" }',
      '    NETWORK',
      '        ',
      '            ;',
      '        ',
      '    END_NETWORK',
      'END_FUNCTION',
    );
    const f = parseBlockText(sdFc, 's7dcl');
    const ctx = { file: f, block: f.blocks[0]! };
    golden(sdFc, setReturnType(ctx, ' Int '), sdFc.replace(': Void', ': Int'), [5]);
    expect(setReturnType(ctx, 'Void').edits).toEqual([]);
    expect(setReturnType(ctx, '').error).toMatch(/Void/);
    expect(setReturnType(ctx, 'Struct').error).toMatch(/cannot be the return type/);
    const srcFc = crlf(
      'FUNCTION "FC_X" : Real',
      "{ S7_Optimized_Access := 'TRUE' }",
      'VERSION : 0.1',
      '   VAR_INPUT ',
      '      a : Int;',
      '   END_VAR',
      '',
      '',
      'BEGIN',
      '\t;',
      'END_FUNCTION',
      '',
    );
    const g = parseBlockText(srcFc, 'source');
    golden(
      srcFc,
      setReturnType({ file: g, block: g.blocks[0]! }, 'Void'),
      srcFc.replace(': Real', ': Void'),
      [0],
    );
    const fb = sdCtx();
    expect(setReturnType(fb, 'Int').error).toMatch(/Only functions/);
  });
});

describe('interface edits in external sources', () => {
  it('adds a member with a line comment', () => {
    golden(
      SRC_DB,
      addMember(
        srcCtx(),
        'Static',
        { name: 'Level', type: 'Real', comment: 'Tank level' },
        { retain: false },
      ),
      SRC_DB.replace(
        '      Count : Int;\r\n',
        '      Count : Int;\r\n      Level : Real;   // Tank level\r\n',
      ),
      [8],
    );
  });

  it('writes flags after the name and drops the block when empty', () => {
    golden(
      SRC_DB,
      setMemberFlags(srcCtx(), ['Count'], { writable: false }),
      SRC_DB.replace('      Count : Int;', "      Count { ExternalWritable := 'False'} : Int;"),
      [7],
    );
    golden(
      SRC_DB,
      setMemberFlags(srcCtx(), ['Count'], { accessible: false }),
      SRC_DB.replace(
        '      Count : Int;',
        "      Count { ExternalAccessible := 'False'; ExternalVisible := 'False'; ExternalWritable := 'False'} : Int;",
      ),
      [7],
    );
    golden(
      SRC_DB,
      setMemberFlags(srcCtx(), ['Speed'], { setpoint: false }),
      SRC_DB.replace("      Speed { S7_SetPoint := 'True'} : Real;", '      Speed : Real;'),
      [6],
    );
  });

  it('edits and removes line comments', () => {
    golden(
      SRC_DB,
      setMemberComment(srcCtx(), ['MachineOn'], 'en-US', 'Machine on'),
      SRC_DB.replace('// Machine switched on', '// Machine on'),
      [5],
    );
    golden(
      SRC_DB,
      setMemberComment(srcCtx(), ['MachineOn'], 'en-US', ''),
      SRC_DB.replace('      MachineOn : Bool;   // Machine switched on', '      MachineOn : Bool;'),
      [5],
    );
    golden(
      SRC_DB,
      setMemberComment(srcCtx(), ['Count'], 'en-US', 'Pieces'),
      SRC_DB.replace('      Count : Int;', '      Count : Int;   // Pieces'),
      [7],
    );
  });

  it('moves a member into the RETAIN section', () => {
    const r = setMemberFlags(srcCtx(), ['Count'], { retain: true });
    golden(
      SRC_DB,
      r,
      SRC_DB.replace('      Count : Int;\r\n', '').replace(
        '      Hours : DInt;   // Operating hours\r\n',
        '      Hours : DInt;   // Operating hours\r\n      Count : Int;\r\n',
      ),
      [7, 8, 9, 10],
    );
    const ctx = srcCtx();
    expect(memberFlags(ctx, findMember(ctx.block, ['Hours'])!).retain).toBe(true);
  });

  it('creates a RETAIN section in a SIMATIC SD DB when needed', () => {
    const file = parseBlockText(SD_DB, 's7dcl');
    const after = apply(
      SD_DB,
      setMemberFlags({ file, block: file.blocks[0]! }, ['MachineOn'], { retain: true }),
    );
    expect(after).toContain(
      '    END_VAR\r\n\r\n    VAR RETAIN\r\n        { S7_MLC := "MLC_1" }\r\n        MachineOn : Bool;\r\n    END_VAR\r\n',
    );
    expect(parseBlockText(after, 's7dcl').diagnostics).toEqual([]);
  });
});

describe('DB start values', () => {
  it('changes, adds and removes start values in a SIMATIC SD DB', () => {
    const file = parseBlockText(SD_DB, 's7dcl');
    const block = file.blocks[0]!;
    expect(startValueText(file, block, 'Speed')).toBe('1.5');
    golden(
      SD_DB,
      setStartValue(file, block, 'Speed', '2.5'),
      SD_DB.replace('Speed := 1.5;', 'Speed := 2.5;'),
      [17],
    );
    golden(
      SD_DB,
      setStartValue(file, block, 'Speed', undefined),
      SD_DB.replace('    Speed := 1.5;\r\n', ''),
      [17],
    );
    golden(
      SD_DB,
      setStartValue(file, block, 'Limits.Minimum', '0.0'),
      SD_DB.replace('    Speed := 1.5;\r\n', '    Speed := 1.5;\r\n    Limits.Minimum := 0.0;\r\n'),
      [18],
    );
  });

  it('adds start values to an instance DB and to an external source', () => {
    const idb = crlf(
      '{',
      '    S7_Optimized := "TRUE"',
      '}',
      'DATA_BLOCK IDB_X : FB_X',
      'END_DATA_BLOCK',
    );
    const f = parseBlockText(idb, 's7dcl');
    golden(
      idb,
      setStartValue(f, f.blocks[0]!, 'Mode', '2'),
      idb.replace('END_DATA_BLOCK', '    Mode := 2;\r\nEND_DATA_BLOCK'),
      [4],
    );
    const s = srcCtx();
    golden(
      SRC_DB,
      setStartValue(s.file, s.block, 'Hours', '10'),
      SRC_DB.replace('   Count := 0;\r\n', '   Count := 0;\r\n   Hours := 10;\r\n'),
      [17],
    );
  });

  it('validates start values against their types', () => {
    const p = profileIndex('V21')!;
    const t = (n: string) => ({ kind: 'elementary' as const, name: n, info: p.elementary(n)! });
    expect(validateStartValue(t('Int'), '40000', p)).toMatch(/outside the range/);
    expect(validateStartValue(t('Int'), '12', p)).toBeUndefined();
    expect(validateStartValue(t('Time'), '5', p)).toMatch(/duration/);
    expect(validateStartValue(t('Time'), 'T#5s', p)).toBeUndefined();
    expect(validateStartValue(t('Real'), '1.5 +', p)).toMatch(/not a valid value/);
  });
});

describe('.s7res edits', () => {
  const res = parseResourcesText(RES);
  it('replaces, inserts in culture order and removes texts', () => {
    expect(applyEdits(RES, setResourceText(res, 'MLC_I1', 'en-US', 'Go'))).toBe(
      RES.replace('en-US: Enable it', 'en-US: Go'),
    );
    expect(applyEdits(RES, setResourceText(res, 'MLC_I1', 'fr-FR', 'Marche'))).toBe(
      RES + '    fr-FR: Marche\r\n',
    );
    expect(applyEdits(RES, setResourceText(res, 'MLC_I1', 'da-DK', 'Start'))).toBe(
      RES.replace('    de-DE', '    da-DK: Start\r\n    de-DE'),
    );
    expect(applyEdits(RES, setResourceText(res, 'MLC_I1', 'de-DE', ''))).toBe(
      RES.replace('    de-DE: Freigabe\r\n', ''),
    );
  });
  it('adds and removes entries and writes new files', () => {
    expect(
      applyEdits(
        RES,
        addResourceEntry(res, 'MLC_N1T', { 'en-US': 'Title: one', 'de-DE': 'Titel' }),
      ),
    ).toBe(RES + "  - id: MLC_N1T\r\n    de-DE: Titel\r\n    en-US: 'Title: one'\r\n");
    expect(applyEdits(RES, removeResourceEntry(res, 'MLC_I1'))).toBe('MultiLingualTexts:\r\n');
    expect(newResourceFileText([{ id: 'A', values: { 'en-US': 'x' } }])).toBe(
      'MultiLingualTexts:\r\n  - id: A\r\n    en-US: x\r\n',
    );
  });
});

const TAGS = crlf(
  '﻿<?xml version="1.0" encoding="utf-8"?>',
  '<Document>',
  '  <Engineering version="V21" />',
  '  <SW.Tags.PlcTagTable ID="0">',
  '    <AttributeList>',
  '      <Name>Tags_IO</Name>',
  '    </AttributeList>',
  '    <ObjectList>',
  '      <SW.Tags.PlcTag ID="1" CompositionName="Tags">',
  '        <AttributeList>',
  '          <DataTypeName>Bool</DataTypeName>',
  '          <LogicalAddress>%I0.0</LogicalAddress>',
  '          <Name>StartButton</Name>',
  '        </AttributeList>',
  '        <ObjectList>',
  '          <MultilingualText ID="2" CompositionName="Comment">',
  '            <ObjectList>',
  '              <MultilingualTextItem ID="3" CompositionName="Items">',
  '                <AttributeList>',
  '                  <Culture>en-US</Culture>',
  '                  <Text>Start push button</Text>',
  '                </AttributeList>',
  '              </MultilingualTextItem>',
  '            </ObjectList>',
  '          </MultilingualText>',
  '        </ObjectList>',
  '      </SW.Tags.PlcTag>',
  '      <SW.Tags.PlcTag ID="4" CompositionName="Tags">',
  '        <AttributeList>',
  '          <DataTypeName>Word</DataTypeName>',
  '          <LogicalAddress>%MW12</LogicalAddress>',
  '          <Name>Status</Name>',
  '        </AttributeList>',
  '      </SW.Tags.PlcTag>',
  '      <SW.Tags.PlcUserConstant ID="5" CompositionName="UserConstants">',
  '        <AttributeList>',
  '          <DataTypeName>Int</DataTypeName>',
  '          <Name>MAXIMUM</Name>',
  '          <Value>1000</Value>',
  '        </AttributeList>',
  '      </SW.Tags.PlcUserConstant>',
  '    </ObjectList>',
  '  </SW.Tags.PlcTagTable>',
  '</Document>',
);

describe('tag table edits', () => {
  const t = parseTagTableText(TAGS);
  const start = findEntry(t, 'StartButton')!;
  const status = findEntry(t, 'Status')!;
  const max = findEntry(t, 'MAXIMUM')!;

  it('renames, retypes, readdresses and changes constant values in place', () => {
    golden(
      TAGS,
      { edits: renameEntryText(t, start, 'StartKey') },
      TAGS.replace('<Name>StartButton</Name>', '<Name>StartKey</Name>'),
      [12],
    );
    golden(
      TAGS,
      setEntryDataType(t, status, 'Int'),
      TAGS.replace('<DataTypeName>Word</DataTypeName>', '<DataTypeName>Int</DataTypeName>'),
      [29],
    );
    golden(TAGS, setEntryAddress(t, status, 'mw14'), TAGS.replace('%MW12', '%MW14'), [30]);
    golden(
      TAGS,
      setConstantValue(t, max, '2000'),
      TAGS.replace('<Value>1000</Value>', '<Value>2000</Value>'),
      [38],
    );
    expect(setEntryAddress(t, max, '%M0.0').error).toMatch(/Only tags/);
  });

  it('inserts flag elements in alphabetical order and only when not default', () => {
    golden(
      TAGS,
      setEntryFlag(t, status, 'ExternalWritable', false),
      TAGS.replace(
        '          <DataTypeName>Word</DataTypeName>\r\n',
        '          <DataTypeName>Word</DataTypeName>\r\n          <ExternalWritable>false</ExternalWritable>\r\n',
      ),
      [30],
    );
    // VCI style (corpus C04): only ExternalAccessible is written; visible and writable follow it
    const hidden = apply(TAGS, setEntryFlag(t, status, 'ExternalAccessible', false));
    expect(hidden).toContain(
      '<DataTypeName>Word</DataTypeName>\r\n          <ExternalAccessible>false</ExternalAccessible>\r\n          <LogicalAddress>',
    );
    const read = parseTagTableText(hidden).entries[1]!;
    expect([read.accessible, read.visible, read.writable]).toEqual([false, false, false]);
    expect(setEntryFlag(t, status, 'ExternalVisible', true).edits).toEqual([]);
    // Openness style (C04 simaticml): the flags the file states are written false as well
    const openness = TAGS.replace(
      '          <DataTypeName>Word</DataTypeName>\r\n',
      '          <DataTypeName>Word</DataTypeName>\r\n          <ExternalAccessible>true</ExternalAccessible>\r\n          <ExternalVisible>true</ExternalVisible>\r\n          <ExternalWritable>true</ExternalWritable>\r\n',
    );
    const o = parseTagTableText(openness);
    expect(apply(openness, setEntryFlag(o, o.entries[1]!, 'ExternalAccessible', false))).toContain(
      '<ExternalAccessible>false</ExternalAccessible>\r\n          <ExternalVisible>false</ExternalVisible>\r\n          <ExternalWritable>false</ExternalWritable>',
    );
  });

  it('edits, adds and removes comments', () => {
    golden(
      TAGS,
      setEntryComment(t, start, 'en-US', 'Start & go'),
      TAGS.replace('<Text>Start push button</Text>', '<Text>Start &amp; go</Text>'),
      [20],
    );
    const de = apply(TAGS, setEntryComment(t, start, 'de-DE', 'Starttaster'));
    expect(parseTagTableText(de).entries[0]!.comments.get('de-DE')?.text).toBe('Starttaster');
    expect(de.indexOf('de-DE')).toBeLessThan(de.indexOf('en-US'));
    const added = apply(TAGS, setEntryComment(t, status, 'en-US', 'Machine status'));
    expect(parseTagTableText(added).entries[1]!.comments.get('en-US')?.text).toBe('Machine status');
    const removed = apply(TAGS, setEntryComment(t, start, 'en-US', ''));
    expect(parseTagTableText(removed).entries[0]!.comments.size).toBe(0);
  });

  it('adds tags after the tags and constants after the constants, with fresh IDs; deletes', () => {
    const r = addEntry(t, {
      kind: 'tag',
      name: 'Lamp',
      dataType: 'Bool',
      addressOrValue: '%Q0.0',
      comments: { 'en-US': 'Lamp' },
    });
    const after = apply(TAGS, r);
    const parsed = parseTagTableText(after);
    expect(parsed.entries.map((e) => e.name)).toEqual(['StartButton', 'Status', 'Lamp', 'MAXIMUM']);
    expect(parsed.entries[2]).toMatchObject({ address: '%Q0.0', dataType: 'Bool' });
    expect(after).toContain('<SW.Tags.PlcTag ID="6" CompositionName="Tags">');
    const c = apply(
      TAGS,
      addEntry(t, { kind: 'constant', name: 'MINIMUM', dataType: 'Int', addressOrValue: '1' }),
    );
    expect(parseTagTableText(c).entries.map((e) => e.name)).toEqual([
      'StartButton',
      'Status',
      'MAXIMUM',
      'MINIMUM',
    ]);
    expect(
      addEntry(t, { kind: 'tag', name: 'status', dataType: 'Bool', addressOrValue: '%M0.0' }).error,
    ).toMatch(/already exists/);
    expect(
      parseTagTableText(apply(TAGS, deleteEntry(t, status))).entries.map((e) => e.name),
    ).toEqual(['StartButton', 'MAXIMUM']);
  });

  it('checks addresses per CPU family and reports overlaps', () => {
    expect(parseAddress('%I0.0')).toMatchObject({ area: 'I', size: 'X', byte: 0, bit: 0 });
    expect(parseAddress('%MW12')).toMatchObject({ area: 'M', size: 'W', byte: 12 });
    expect(parseAddress('%I0.8')).toBeUndefined();
    const bad = parseTagTableText(
      TAGS.replace('%MW12', '%M12.0').replace(
        '<DataTypeName>Bool</DataTypeName>',
        '<DataTypeName>Int</DataTypeName>',
      ),
    );
    const problems = addressProblems([bad], 'S7-1200').map((p) => p.message);
    expect(problems.some((m) => /Int needs a word address/.test(m))).toBe(true);
    expect(problems.some((m) => /Word needs a word address/.test(m))).toBe(true);
    const overlap = parseTagTableText(
      TAGS.replace('%I0.0', '%M12.1').replace(
        '<DataTypeName>Word</DataTypeName>',
        '<DataTypeName>Word</DataTypeName>',
      ),
    );
    expect(addressProblems([overlap], 'S7-1500').map((p) => p.severity)).toEqual(['info']);
    const far = parseTagTableText(TAGS.replace('%MW12', '%MW9000'));
    expect(addressProblems([far], 'S7-1200').some((p) => /beyond/.test(p.message))).toBe(true);
    expect(addressProblems([far], 'S7-1500')).toEqual([]);
  });

  it('exports CSV and imports it back without changes (round trip)', () => {
    const csv = exportCsv(t);
    expect(csv.split('\r\n')[0]).toBe(
      'Kind,Name,DataType,Address,Value,Accessible,Visible,Writable,Comment en-US',
    );
    const { changes, problems } = csvChanges(t, csv);
    expect(problems).toEqual([]);
    expect(changes.map((c) => nextCsvEdit(t, c))).toEqual([undefined, undefined, undefined]);
  });

  it('guards comments that a spreadsheet would read as a formula, and reads them back', () => {
    const risky = apply(TAGS, setEntryComment(t, start, 'en-US', '=HYPERLINK("x")'));
    const table = parseTagTableText(risky);
    const csv = exportCsv(table);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const { changes, problems } = csvChanges(table, csv);
    expect(problems).toEqual([]);
    expect(changes.map((c) => nextCsvEdit(table, c))).toEqual([undefined, undefined, undefined]);
  });

  it('imports a whole CSV as one set of minimal line edits (one undo step)', () => {
    const csv =
      exportCsv(t).replace('%MW12', '%MW20').replace('Start push button', '"Start, push"') +
      'Tag,Lamp,Bool,%Q0.0,,true,true,true,Lamp\r\n';
    const result = csvImport(TAGS, csv);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(3);
    const after = applyEdits(TAGS, result.edits);
    const final = parseTagTableText(after);
    expect(final.entries.map((e) => [e.name, e.address ?? e.value])).toEqual([
      ['StartButton', '%I0.0'],
      ['Status', '%MW20'],
      ['Lamp', '%Q0.0'],
      ['MAXIMUM', '1000'],
    ]);
    // the same text as applying the steps one by one, and no edit spans an unchanged line
    const unchanged = new Set(
      TAGS.split('\r\n').filter((line) => after.split('\r\n').includes(line)),
    );
    for (const e of result.edits)
      for (const line of TAGS.slice(e.start, e.end).split('\r\n').filter(Boolean))
        expect(unchanged.has(line) && after.includes(line + '\r\n')).toBe(false);
    expect(csvImport(after, csv)).toEqual({ edits: [], applied: 0, problems: [] });
  });

  it('imports changed and new rows from CSV, one edit at a time', () => {
    const csv =
      exportCsv(t).replace('%MW12', '%MW20').replace('Start push button', '"Start, push"') +
      'Tag,Lamp,Bool,%Q0.0,,true,true,true,Lamp\r\n';
    let text = TAGS;
    for (let guard = 0; guard < 10; guard++) {
      const table = parseTagTableText(text);
      const { changes } = csvChanges(table, csv);
      const next = changes.map((c) => nextCsvEdit(table, c)).find((e) => e !== undefined);
      if (!next) break;
      text = apply(text, next);
    }
    const final = parseTagTableText(text);
    expect(final.entries.map((e) => [e.name, e.address ?? e.value])).toEqual([
      ['StartButton', '%I0.0'],
      ['Status', '%MW20'],
      ['Lamp', '%Q0.0'],
      ['MAXIMUM', '1000'],
    ]);
    expect(final.entries[0]!.comments.get('en-US')?.text).toBe('Start, push');
  });
});

describe('line diff', () => {
  const lines = (...l: string[]) => l.map((x) => x + '\r\n').join('');

  it('touches only the lines that differ', () => {
    const before = lines('a', 'b', 'c', 'd', 'e');
    const after = lines('a', 'B', 'c', 'd', 'x', 'e');
    const edits = lineDiffEdits(before, after);
    expect(applyEdits(before, edits)).toBe(after);
    expect(edits.map((e) => before.slice(e.start, e.end))).toEqual(['b\r\n', '']);
  });

  it('turns any text into any other (random lines)', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const make = () =>
        Array.from({ length: rnd(12) }, () => 'abcde'[rnd(5)]!)
          .map((x) => x + (rnd(4) === 0 ? '\n' : '\r\n'))
          .join('') + (rnd(3) === 0 ? 'tail' : '');
      const before = make();
      const after = make();
      expect(applyEdits(before, lineDiffEdits(before, after))).toBe(after);
    }
  });
});
