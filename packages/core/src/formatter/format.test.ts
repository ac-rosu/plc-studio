import { describe, expect, it } from 'vitest';
import { applyEdits, changedLines } from '../writer/text-edit.ts';
import { formatDocument, formatRanges } from './format.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

const doc = (...body: string[]) =>
  crlf(
    '{',
    '    S7_EditorMode := "SCL"',
    '}',
    'FUNCTION_BLOCK "FB_X"',
    '    VAR',
    '        a:Int;',
    '        Counter : Int := 1;',
    '        { S7_MLC := "MLC_1" }',
    '        Long_Name : Real;',
    '    END_VAR',
    '    { S7_Language := "SCL" }',
    '    NETWORK',
    '        ',
    ...body,
    '        ',
    '    END_NETWORK',
    'END_FUNCTION_BLOCK',
  );

describe('formatter', () => {
  it('indents, spaces and upper-cases like TIA', () => {
    const text = doc(
      'region Loop',
      'if #a>1 then',
      '#a:=#a+1;',
      'elsif #a<0 then',
      '  #a := -1;',
      'else',
      '#a := 0;',
      'end_if;',
      'case #a of',
      '1:',
      '#a := 2;',
      'else',
      '#a := 3;',
      'end_case;',
      'end_region',
    );
    const out = applyEdits(text, formatDocument('FB_X.s7dcl', text));
    expect(out).toBe(
      doc(
        '            REGION Loop',
        '                IF #a > 1 THEN',
        '                    #a := #a + 1;',
        '                ELSIF #a < 0 THEN',
        '                    #a := -1;',
        '                ELSE',
        '                    #a := 0;',
        '                END_IF;',
        '                CASE #a OF',
        '                    1:',
        '                        #a := 2;',
        '                    ELSE',
        '                        #a := 3;',
        '                END_CASE;',
        '            END_REGION',
      ).replace('        a:Int;', '        a : Int;'),
    );
  });

  it('touches only the requested lines', () => {
    const text = doc('#a:=1;', '#a:=2;', '#a:=3;');
    const edits = formatRanges('FB_X.s7dcl', text, [{ start: 14, end: 14 }]);
    const out = applyEdits(text, edits);
    expect(changedLines(text, out)).toEqual([14]);
    expect(out.split('\r\n')[14]).toBe('            #a := 2;');
  });

  it('keeps continuation lines, comments, attribute blocks and REGION titles as written', () => {
    const text = doc(
      '            #b(x := 1,',
      '                  y:=2);   //  keep   this',
      '            REGION  Two  spaces',
      '            END_REGION',
    );
    const out = applyEdits(text, formatDocument('FB_X.s7dcl', text));
    const lines = out.split('\r\n');
    expect(lines[14]).toBe('                  y := 2);   //  keep   this');
    expect(lines[15]).toBe('            REGION  Two  spaces');
    expect(lines[7]).toBe('        { S7_MLC := "MLC_1" }');
  });

  it('keyword case and alignment are options', () => {
    const text = doc('IF #a > 1 THEN #a := 1; END_IF;');
    expect(
      applyEdits(text, formatDocument('FB_X.s7dcl', text, { keywordCase: 'lower' })),
    ).toContain('if #a > 1 then #a := 1; end_if;');
    const aligned = applyEdits(
      text,
      formatDocument('FB_X.s7dcl', text, { alignAssignments: true }),
    ).split('\r\n');
    expect(aligned[5]).toBe('        a       : Int;');
    expect(aligned[6]).toBe('        Counter : Int := 1;');
  });

  it('leaves code with syntax errors and LAD networks alone', () => {
    const broken = doc('IF #a > 1 THEN', '#a:=1;');
    expect(
      formatDocument('FB_X.s7dcl', broken).every(
        (e) => !broken.slice(e.start, e.end).includes('#a:=1'),
      ),
    ).toBe(true);
    const lad = crlf(
      'FUNCTION "FC_L" : Void',
      '    { S7_Language := "LAD" }',
      '    NETWORK',
      '        RUNG wire#powerrail',
      '            Contact(  #a  )',
      '        END_RUNG',
      '    END_NETWORK',
      'END_FUNCTION',
    );
    expect(formatDocument('FC_L.s7dcl', lad)).toEqual([]);
  });

  it('indents external sources with a TAB plus 4 spaces per level', () => {
    const scl = crlf(
      'FUNCTION_BLOCK "FB_S"',
      'VERSION : 0.1',
      '   VAR',
      '      a : Int;',
      '   END_VAR',
      '',
      'BEGIN',
      '\t',
      'IF #a > 0 THEN',
      '#a := 0;',
      'END_IF;',
      'END_FUNCTION_BLOCK',
      '',
    );
    const out = applyEdits(scl, formatDocument('FB_S.scl', scl)).split('\r\n');
    expect(out.slice(8, 11)).toEqual([
      '\t    IF #a > 0 THEN',
      '\t        #a := 0;',
      '\t    END_IF;',
    ]);
  });
});
