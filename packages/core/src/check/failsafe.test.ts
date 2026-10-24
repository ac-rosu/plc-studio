import { describe, expect, it } from 'vitest';
// the index registers the fail-safe pass
import { analyzeProject, Project } from '../index.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

function project(files: Record<string, string>, manifest: object = {}): Project {
  const p = new Project('/plc');
  p.setManifest(
    '/plc/plc.json',
    JSON.stringify({
      name: 'P',
      cpu: { family: 'S7-1500', failsafe: true },
      tiaVersion: 'V21',
      ...manifest,
    }),
  );
  for (const [name, text] of Object.entries(files)) p.setFileText(`/plc/${name}`, text);
  return p;
}

function found(p: Project, ...codes: string[]) {
  const out: string[] = [];
  for (const [file, list] of analyzeProject(p).diagnostics) {
    const source = p.files.get(file)?.source;
    for (const d of list)
      if (codes.includes(d.code))
        out.push(
          `${file.slice(file.lastIndexOf('/') + 1)}:${(source?.positionAt(d.range.start).line ?? 0) + 1} ${d.severity} ${d.code}: ${d.message}`,
        );
  }
  return out.sort();
}

/** A LAD or FBD FC; `safety` makes it an F-block (S7_Safety, as TIA writes it). */
const ladFc = (name: string, safety: boolean, decl: string[], rung: string[]) =>
  crlf(
    '{',
    '    S7_Optimized := "TRUE";',
    '    S7_PreferredLanguage := "LAD";',
    ...(safety ? ['    S7_Safety := "TRUE";'] : []),
    '    S7_Version := "0.1"',
    '}',
    `FUNCTION "${name}" : Void`,
    ...decl,
    '',
    '    { S7_Language := "LAD" }',
    '    NETWORK',
    '        RUNG wire#powerrail',
    ...rung.map((l) => '            ' + l),
    '        END_RUNG',
    '    END_NETWORK',
    'END_FUNCTION',
  );

const sclFc = (name: string, decl: string[], body: string[]) =>
  crlf(
    '{',
    '    S7_EditorMode := "SCL";',
    '    S7_Optimized := "TRUE";',
    '    S7_Version := "0.1"',
    '}',
    `FUNCTION "${name}" : Void`,
    ...decl,
    '',
    '    { S7_Language := "SCL" }',
    '    NETWORK',
    '        ',
    ...body.map((l) => '            ' + l),
    '        ',
    '    END_NETWORK',
    'END_FUNCTION',
  );

const F_DB = crlf(
  '{',
  '    S7_Optimized := "TRUE";',
  '    S7_Safety := "TRUE";',
  '    S7_Version := "0.1"',
  '}',
  'DATA_BLOCK "F_DB"',
  '    VAR',
  '        Setup : Bool;',
  '        Released : Bool;',
  '    END_VAR',
  'END_DATA_BLOCK',
);

const STD_DB = crlf(
  '{',
  '    S7_Optimized := "TRUE";',
  '    S7_Version := "0.1"',
  '}',
  'DATA_BLOCK "DB_Std"',
  '    VAR',
  '        On : Bool;',
  '        Other : Bool;',
  '        Pair : Struct',
  '            A : Bool;',
  '            B : Bool;',
  '        END_STRUCT;',
  '    END_VAR',
  'END_DATA_BLOCK',
);

const io = (decl: string[]) => ['    VAR_INPUT', ...decl, '    END_VAR'];

describe('fail-safe interface types (corpus B23, B39, C35)', () => {
  it('refuses the types TIA refuses, accepts the permitted ones and PLC data types', () => {
    const p = project({
      'F_FC_T.s7dcl': ladFc(
        'F_FC_T',
        true,
        io([
          '        A : Bool;',
          '        B : Int;',
          '        C : DInt;',
          '        D : Word;',
          '        E : Time;',
          '        F : DWord;',
          '        G : Array[0..1] of Bool;',
          '        H : Real;',
        ]),
        ['Contact( #A )', 'Coil( #A )'],
      ),
    });
    expect(found(p, 'failsafe-type')).toEqual([
      'F_FC_T.s7dcl:14 error failsafe-type: DWord is not permitted in the interface of a fail-safe block.',
      'F_FC_T.s7dcl:15 error failsafe-type: Array[0..1] of Bool is not permitted in the interface of a fail-safe block.',
      'F_FC_T.s7dcl:16 error failsafe-type: Real is not permitted in the interface of a fail-safe block.',
    ]);
  });
});

describe('box data types (corpus B40, B41, C36, C37)', () => {
  const decl = [
    '    VAR_INPUT',
    '        X : Int;',
    '    END_VAR',
    '    VAR_OUTPUT',
    '        Y : Int;',
    '        W : DInt;',
    '    END_VAR',
  ];
  const sub = (templates: string[]) => [
    ...templates,
    'Sub(',
    '    in1 := #X,',
    '    in2 := #X,',
    '    out => #Y',
    ')',
  ];

  it('an F-block box needs its type; a standard block lets TIA choose', () => {
    const p = project({
      'F_FC_A.s7dcl': ladFc('F_FC_A', true, decl, sub([])),
      'F_FC_B.s7dcl': ladFc('F_FC_B', true, decl, sub(['{ S7_Templates := "SrcType := Int" }'])),
      'F_FC_C.s7dcl': ladFc('F_FC_C', true, decl, sub(['{ Type := "" }'])),
      'FC_D.s7dcl': ladFc('FC_D', false, decl, sub([])),
    });
    expect(found(p, 'box-type-missing')).toEqual([
      'F_FC_A.s7dcl:19 error box-type-missing: In a fail-safe block the Sub box needs an explicit data type (SrcType).',
      'F_FC_C.s7dcl:20 error box-type-missing: In a fail-safe block the Sub box needs an explicit data type (SrcType).',
    ]);
  });

  it('Convert needs both types in every block', () => {
    const conv = (templates: string[]) => [
      ...templates,
      'Convert(',
      '    in := #X,',
      '    out => #W',
      ')',
    ];
    const p = project({
      'FC_A.s7dcl': ladFc('FC_A', false, decl, conv([])),
      'FC_B.s7dcl': ladFc('FC_B', false, decl, conv(['{ S7_Templates := "SrcType := Int" }'])),
      'FC_C.s7dcl': ladFc(
        'FC_C',
        false,
        decl,
        conv(['{', '    S7_Templates := "[SrcType := Int, DestType := DInt]"', '}']),
      ),
    });
    expect(found(p, 'box-type-missing')).toEqual([
      'FC_A.s7dcl:18 error box-type-missing: The Convert box needs its data types (SrcType, DestType); TIA does not choose them.',
      'FC_B.s7dcl:19 error box-type-missing: The Convert box needs its data types (DestType); TIA does not choose them.',
    ]);
  });
});

describe('instructions TIA does not have in fail-safe blocks (corpus B46)', () => {
  it('MAX in an F-block is an error, in a standard block it is fine', () => {
    const decl = [
      '    VAR_INPUT',
      '        X : Int;',
      '    END_VAR',
      '    VAR_OUTPUT',
      '        Y : Int;',
      '    END_VAR',
    ];
    const max = [
      '{ S7_Templates := "SrcType := Int" }',
      'MAX(',
      '    in1 := #X,',
      '    in2 := #X,',
      '    out => #Y',
      ')',
    ];
    const p = project({
      'F_FC_M.s7dcl': ladFc('F_FC_M', true, decl, max),
      'FC_M.s7dcl': ladFc('FC_M', false, decl, max),
    });
    expect(found(p, 'failsafe-instruction')).toEqual([
      'F_FC_M.s7dcl:19 error failsafe-instruction: MAX is not available in fail-safe blocks.',
    ]);
  });
});

describe('the boundary between the safety program and the standard program (B42–B44, C38)', () => {
  it('no calls across it, in either direction', () => {
    const p = project({
      'F_FC_Logic.s7dcl': ladFc('F_FC_Logic', true, io(['        In : Bool;']), [
        'Contact( #In )',
        'Coil( #In )',
      ]),
      'FC_Helper.s7dcl': ladFc('FC_Helper', false, io(['        In : Bool;']), [
        'Contact( #In )',
        'Coil( #In )',
      ]),
      'FC_CallF.s7dcl': sclFc('FC_CallF', [], ['"F_FC_Logic"(In := TRUE);']),
      'F_FC_CallStd.s7dcl': ladFc(
        'F_FC_CallStd',
        true,
        [],
        ['"FC_Helper"(', '    In := TRUE', ')'],
      ),
    });
    expect(found(p, 'failsafe-call')).toEqual([
      'FC_CallF.s7dcl:11 error failsafe-call: A standard block cannot call the fail-safe block F_FC_Logic.',
      'F_FC_CallStd.s7dcl:12 error failsafe-call: A fail-safe block cannot call the standard block FC_Helper.',
    ]);
  });

  it('standard blocks read F-DBs but do not write them', () => {
    const p = project({
      'F_DB.s7dcl': F_DB,
      'FC_Read.s7dcl': sclFc(
        'FC_Read',
        ['    VAR_TEMP', '        t : Bool;', '    END_VAR'],
        ['#t := "F_DB".Released;'],
      ),
      'FC_Write.s7dcl': sclFc('FC_Write', [], ['"F_DB".Setup := TRUE;']),
    });
    expect(found(p, 'failsafe-standard-write')).toEqual([
      'FC_Write.s7dcl:11 error failsafe-standard-write: A standard block cannot write "F_DB".Setup: F_DB is a fail-safe DB.',
    ]);
  });
});

describe('standard data in the safety program (B45, C39)', () => {
  const files = () => ({
    'DB_Std.s7dcl': STD_DB,
    'F_FC_Data.s7dcl': ladFc(
      'F_FC_Data',
      true,
      ['    VAR_TEMP', '        t : Bool;', '    END_VAR'],
      ['Contact( "DB_Std".On )', 'Coil( "DB_Std".On )'],
    ),
    'F_FC_Ok.s7dcl': ladFc(
      'F_FC_Ok',
      true,
      ['    VAR_TEMP', '        t : Bool;', '    END_VAR'],
      ['Contact( "DB_Std".Pair.A )', 'Coil( "DB_Std".Pair.B )'],
    ),
    'F_FC_Main.s7dcl': ladFc('F_FC_Main', true, [], ['"F_FC_Data"()', '"F_FC_Ok"()']),
    'F_FC_Spare.s7dcl': ladFc('F_FC_Spare', true, io(['        In : Bool;']), [
      'Contact( #In )',
      'Coil( #In )',
    ]),
  });

  it('with the main safety blocks in plc.json: an error at every access, and F-blocks outside are listed', () => {
    const p = project(files(), { mainSafetyBlocks: ['F_FC_Main'] });
    expect(found(p, 'failsafe-read-write', 'failsafe-unused')).toEqual([
      'F_FC_Data.s7dcl:15 error failsafe-read-write: The safety program reads the standard operand "DB_Std".On, which it also writes; standard data may only be read or only be written there.',
      'F_FC_Data.s7dcl:16 error failsafe-read-write: The safety program writes the standard operand "DB_Std".On, which it also reads; standard data may only be read or only be written there.',
      'F_FC_Spare.s7dcl:7 warning failsafe-unused: F_FC_Spare is not called from a main safety block, so it is not part of the safety program.',
    ]);
  });

  it('without them only warnings, since the files do not say what the safety program is', () => {
    const p = project(files());
    expect(found(p, 'failsafe-read-write').map((d) => d.split(' ')[1])).toEqual([
      'warning',
      'warning',
    ]);
    expect(found(p, 'failsafe-unused')).toEqual([]);
  });
});
