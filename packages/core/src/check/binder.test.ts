import { describe, expect, it } from 'vitest';
import { Project } from '../model/project.ts';
import { analyzeProject } from './analysis.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

function project(files: Record<string, string>, manifest: object = {}): Project {
  const p = new Project('/plc');
  p.setManifest(
    '/plc/plc.json',
    JSON.stringify({ name: 'P', cpu: { family: 'S7-1500' }, tiaVersion: 'V21', ...manifest }),
  );
  for (const [name, text] of Object.entries(files)) p.setFileText(`/plc/${name}`, text);
  return p;
}

function diagnostics(p: Project, severity?: string) {
  const out: { file: string; code: string; severity: string; message: string; line: number }[] = [];
  for (const [file, list] of analyzeProject(p).diagnostics) {
    const source = p.files.get(file)?.source;
    for (const d of list) {
      if (!severity || d.severity === severity)
        out.push({
          file,
          code: d.code,
          severity: d.severity,
          message: d.message,
          line: (source?.positionAt(d.range.start).line ?? 0) + 1,
        });
    }
  }
  return out;
}

const UDT = crlf(
  'TYPE',
  '    UDT_Motor : STRUCT',
  '        Speed : Real;',
  '        On : Bool;',
  '    END_STRUCT;',
  'END_TYPE',
);

const sclFb = (name: string, decl: string[], body: string[]) =>
  crlf(
    '{',
    '    S7_EditorMode := "SCL"',
    '}',
    `FUNCTION_BLOCK "${name}"`,
    ...decl,
    '    { S7_Language := "SCL" }',
    '    NETWORK',
    '        ',
    ...body.map((l) => '            ' + l),
    '        ',
    '    END_NETWORK',
    'END_FUNCTION_BLOCK',
  );

const TIMERS = sclFb(
  'FB_Callee',
  [
    '    VAR_INPUT',
    '        Start : Bool;',
    '    END_VAR',
    '    VAR_IN_OUT',
    '        Data : _.UDT_Motor;',
    '    END_VAR',
    '    VAR_OUTPUT',
    '        Done : Bool;',
    '    END_VAR',
  ],
  ['#Done := #Start AND #Data.On;'],
);

describe('binding across files', () => {
  it('resolves UDT members, DB members and calls, and finds no errors in valid code', () => {
    const p = project({
      'UDT_Motor.s7dcl': UDT,
      'FB_Callee.s7dcl': TIMERS,
      'DB_Data.s7dcl': crlf(
        'DATA_BLOCK DB_Data',
        '    VAR',
        '        Count : Int;',
        '    END_VAR',
        '',
        '    Count := 5;',
        '',
        'END_DATA_BLOCK',
      ),
      'FB_Main.s7dcl': sclFb(
        'FB_Main',
        [
          '    VAR',
          '        Motor : _.UDT_Motor;',
          '        Callee : FB_Callee;',
          '        Delay : TON_TIME;',
          '    END_VAR',
        ],
        [
          '#Motor.Speed := 12.5;',
          '"DB_Data".Count := "DB_Data".Count + 1;',
          '#Callee(Start := TRUE, Data := #Motor, Done => #Motor.On);',
          '#Delay(IN := #Motor.On, PT := T#2s);',
        ],
      ),
    });
    expect(diagnostics(p).filter((d) => d.severity !== 'info')).toEqual([]);
    const analysis = analyzeProject(p);
    expect(analysis.referencesBySymbol.get('member:udt_motor/speed')?.map((r) => r.access)).toEqual(
      ['declaration', 'write'],
    );
    expect(analysis.referencesBySymbol.get('member:db_data/count')?.map((r) => r.access)).toEqual([
      'declaration',
      'write',
      'write',
      'read',
    ]);
    expect(analysis.calls.map((c) => [c.calleeName, c.kind, c.instance?.kind])).toEqual([
      ['FB_Callee', 'fb', 'multi'],
      ['TON', 'instruction', 'multi'],
    ]);
  });
});

describe('checker errors (each backed by a corpus case)', () => {
  it('undeclared local: error in FB/FC (B01), warning in an OB', () => {
    const p = project({
      'FB_A.s7dcl': sclFb('FB_A', ['    VAR', '        a : Int;', '    END_VAR'], ['#a := #b;']),
      'OB_1.s7dcl': crlf(
        '{',
        '    S7_EditorMode := "SCL"',
        '}',
        'ORGANIZATION_BLOCK "OB_1"',
        '    { S7_Language := "SCL" }',
        '    NETWORK',
        '        ',
        '            IF #Initial_Call THEN ; END_IF;',
        '        ',
        '    END_NETWORK',
        'END_ORGANIZATION_BLOCK',
      ),
    });
    const d = diagnostics(p).filter((x) => x.code === 'undeclared-local');
    expect(d.map((x) => [x.file.split('/').pop(), x.severity])).toEqual([
      ['FB_A.s7dcl', 'error'],
      ['OB_1.s7dcl', 'warning'],
    ]);
  });

  it('unknown parameter (B04) and missing InOut (B05)', () => {
    const p = project({
      'UDT_Motor.s7dcl': UDT,
      'FB_Callee.s7dcl': TIMERS,
      'FB_Main.s7dcl': sclFb(
        'FB_Main',
        ['    VAR', '        Callee : FB_Callee;', '    END_VAR'],
        ['#Callee(Strat := TRUE);'],
      ),
    });
    expect(
      diagnostics(p, 'error')
        .map((d) => d.code)
        .sort(),
    ).toEqual(['missing-inout-parameter', 'unknown-parameter']);
  });

  it('a plain number on a Time parameter (B14)', () => {
    const p = project({
      'FB_T.s7dcl': sclFb(
        'FB_T',
        ['    VAR', '        Delay : TON_TIME;', '    END_VAR'],
        ['#Delay(IN := TRUE, PT := 5);'],
      ),
    });
    expect(diagnostics(p, 'error').map((d) => d.code)).toEqual(['type-mismatch']);
  });

  it('assignment to a user constant (B09) and to a local constant', () => {
    const tags = `<Document><SW.Tags.PlcTagTable ID="0"><AttributeList><Name>T</Name></AttributeList><ObjectList>
<SW.Tags.PlcUserConstant ID="1"><AttributeList><DataTypeName>Int</DataTypeName><Name>LIMIT</Name><Value>5</Value></AttributeList></SW.Tags.PlcUserConstant>
</ObjectList></SW.Tags.PlcTagTable></Document>`;
    const p = project({
      'PLC tags/T.xml': tags,
      'FB_C.s7dcl': sclFb(
        'FB_C',
        ['    VAR CONSTANT', '        MAX : Int := 3;', '    END_VAR'],
        ['"LIMIT" := 1;', '#MAX := 2;'],
      ),
    });
    expect(diagnostics(p, 'error').map((d) => d.code)).toEqual([
      'assign-to-constant',
      'assign-to-constant',
    ]);
  });

  it('FOR counter: Real is not allowed (B11), changing it is reported at the FOR (B26)', () => {
    const p = project({
      'FB_F.s7dcl': sclFb(
        'FB_F',
        ['    VAR_TEMP', '        r : Real;', '        i : Int;', '    END_VAR'],
        ['FOR #r := 0.0 TO 9.0 DO ; END_FOR;', 'FOR #i := 0 TO 9 DO', '    #i := 10;', 'END_FOR;'],
      ),
    });
    const d = diagnostics(p, 'error');
    expect(d.map((x) => x.code)).toEqual(['for-counter-type', 'for-counter-modified']);
    expect(d[1]!.line).toBe(13);
  });

  it('IEC check: error with it on (B08), warning without (C10)', () => {
    const fc = (iec: boolean) =>
      crlf(
        '{',
        '    S7_EditorMode := "SCL"' + (iec ? ';' : ''),
        ...(iec ? ['    S7_IECCheck := "TRUE"'] : []),
        '}',
        'FUNCTION "FC_I" : Void',
        '    VAR_TEMP',
        '        w : Word;',
        '        i : Int;',
        '    END_VAR',
        '    { S7_Language := "SCL" }',
        '    NETWORK',
        '        ',
        '            #i := #w;',
        '        ',
        '    END_NETWORK',
        'END_FUNCTION',
      );
    expect(
      diagnostics(project({ 'FC_I.s7dcl': fc(true) })).map((d) => [d.code, d.severity]),
    ).toEqual([['iec-implicit-conversion', 'error']]);
    expect(
      diagnostics(project({ 'FC_I.s7dcl': fc(false) })).map((d) => [d.code, d.severity]),
    ).toEqual([['implicit-conversion', 'warning']]);
  });

  it('start value out of range (B15) and S7-1500-only types on S7-1200 (B24)', () => {
    const db = crlf(
      'DATA_BLOCK DB_R',
      '    VAR',
      '        Count : Int;',
      '        Precise : LTime;',
      '    END_VAR',
      '',
      '    Count := 40000;',
      '',
      'END_DATA_BLOCK',
    );
    const d = diagnostics(project({ 'DB_R.s7dcl': db }, { cpu: { family: 'S7-1200' } }), 'error');
    expect(d.map((x) => x.code).sort()).toEqual(['not-available-on-cpu', 'value-out-of-range']);
  });

  it('LAD: Int on a contact (B18), unwired box input (B19), Bool on a number input (B20)', () => {
    const lad = crlf(
      'FUNCTION "FC_L" : Void',
      '    VAR_INPUT',
      '        Count : Int;',
      '        Start : Bool;',
      '    END_VAR',
      '    { S7_Language := "LAD" }',
      '    NETWORK',
      '        RUNG wire#powerrail',
      '            Contact( #Count )',
      '            Coil( #Start )',
      '        END_RUNG',
      '    END_NETWORK',
      '    { S7_Language := "LAD" }',
      '    NETWORK',
      '        RUNG wire#powerrail',
      '            Add(',
      '                in1 := #Count,',
      '                out => #Count',
      '            )',
      '        END_RUNG',
      '    END_NETWORK',
      '    { S7_Language := "LAD" }',
      '    NETWORK',
      '        RUNG wire#powerrail',
      '            Add(',
      '                in1 := #Count,',
      '                in2 := #Start,',
      '                out => #Count',
      '            )',
      '        END_RUNG',
      '    END_NETWORK',
      'END_FUNCTION',
    );
    expect(diagnostics(project({ 'FC_L.s7dcl': lad }), 'error').map((d) => d.code)).toEqual([
      'type-mismatch',
      'missing-box-input',
      'type-mismatch',
    ]);
  });

  it('unit access: unpublished object (B21) and missing relation (B22)', () => {
    const unitFc = (name: string, published: boolean) =>
      crlf(
        'NAMESPACE Filling',
        '    {',
        '        S7_EditorMode := "SCL";',
        `        S7_UnitAccess := "${published ? 'Published' : 'Unpublished'}"`,
        '    }',
        `    FUNCTION "${name}" : Void`,
        '        { S7_Language := "SCL" }',
        '        NETWORK',
        '            ',
        '            ',
        '        END_NETWORK',
        '    END_FUNCTION',
        'END_NAMESPACE',
      );
    const caller = (ns: string) =>
      crlf(
        `NAMESPACE ${ns}`,
        '    {',
        '        S7_EditorMode := "SCL"',
        '    }',
        '    FUNCTION_BLOCK "FB_Use"',
        '        { S7_Language := "SCL" }',
        '        NETWORK',
        '            ',
        '                _.Filling.FC_Hidden();',
        '                _.Filling.FC_Open();',
        '            ',
        '        END_NETWORK',
        '    END_FUNCTION_BLOCK',
        'END_NAMESPACE',
      );
    const units = [
      { name: 'Unit_Filling', folder: 'Units/Filling', namespace: 'Filling' },
      {
        name: 'Unit_Dosing',
        folder: 'Units/Dosing',
        namespace: 'Dosing',
        relations: ['Unit_Filling'],
      },
      { name: 'Unit_Mixing', folder: 'Units/Mixing', namespace: 'Mixing' },
    ];
    const files = {
      'Units/Filling/FC_Hidden.s7dcl': unitFc('FC_Hidden', false),
      'Units/Filling/FC_Open.s7dcl': unitFc('FC_Open', true),
      'Units/Dosing/FB_Use.s7dcl': caller('Dosing'),
      'Units/Mixing/FB_Use.s7dcl': caller('Mixing'),
    };
    const d = diagnostics(project(files, { units }), 'error');
    const dosing = d.filter((x) => x.file.includes('Dosing')).map((x) => x.code);
    const mixing = d.filter((x) => x.file.includes('Mixing')).map((x) => x.code);
    expect(dosing).toEqual(['unpublished-access']);
    expect(mixing.sort()).toEqual(['missing-relation', 'missing-relation', 'unpublished-access']);
  });

  it('names that differ only by case are a policy error (ADR 0013); exact duplicates are errors', () => {
    const p = project({
      'FB_D.s7dcl': sclFb(
        'FB_D',
        [
          '    VAR',
          '        State : Int;',
          '        state : Int;',
          '        Mode : Int;',
          '        Mode : Int;',
          '    END_VAR',
        ],
        [],
      ),
    });
    expect(diagnostics(p, 'error').map((d) => d.code)).toEqual([
      'case-only-duplicate',
      'duplicate-name',
    ]);
  });

  it('a missing block is only a warning: the export may be partial', () => {
    const p = project({ 'FB_M.s7dcl': sclFb('FB_M', [], ['"FC_NotExported"();']) });
    expect(diagnostics(p).map((d) => [d.code, d.severity])).toEqual([
      ['unknown-global', 'warning'],
    ]);
  });

  it('without a manifest only syntax is checked', () => {
    const p = new Project('/plc');
    p.setFileText('/plc/FB_A.s7dcl', sclFb('FB_A', [], ['#nothing := 1;']));
    expect(diagnostics(p)).toEqual([]);
  });
});
