import { describe, expect, it } from 'vitest';
import type { Block, Statement } from './ast.ts';
import { lex, T } from './lexer.ts';
import { parseBlockText } from './parser.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

function sclBlock(...body: string[]) {
  return parseBlockText(
    crlf(
      'FUNCTION_BLOCK "FB_X"',
      'VERSION : 0.1',
      '   VAR_INPUT',
      '      a : Int;',
      '   END_VAR',
      '   VAR_TEMP',
      '      i : Int;',
      '   END_VAR',
      'BEGIN',
      ...body,
      'END_FUNCTION_BLOCK',
    ),
    'source',
  );
}

const statements = (block: Block): Statement[] => block.networks[0]!.statements!;

describe('lexer', () => {
  it('covers every character, also of garbage, in order', () => {
    const samples = [
      'IF #a > 1 THEN #b := T#1s; END_IF;',
      '"x y".z := 16#FF_FF + 2#1010 - 1.5E-3 ** 2;',
      "s := 'it$'s'; w := WSTRING#'x'; d := DT#2026-01-01-06:00:00;",
      '%I0.0 %MW12 %DB1.DBX0.0 wire#powerrail',
      '(* block *) /* c */ // line\r\n\tä€@?!~`\\',
      'unterminated "quote\n\'string',
    ];
    for (let n = 0; n < 200; n++) {
      samples.push(
        Array.from({ length: 40 }, () =>
          String.fromCharCode(32 + Math.floor(Math.random() * 95)),
        ).join(''),
      );
    }
    for (const text of samples) {
      const tokens = lex(text);
      let pos = 0;
      for (const t of tokens) {
        expect(t.start).toBe(pos);
        pos = t.end;
      }
      expect(pos).toBe(text.length);
      expect(tokens.at(-1)!.kind).toBe(T.EOF);
    }
  });

  it('recognizes typed literals, addresses and wires', () => {
    const kinds = (text: string) =>
      lex(text)
        .filter((t) => t.kind !== T.Whitespace && t.kind !== T.EOF)
        .map((t) => t.kind);
    expect(kinds('T#3s LT#500US TOD#06:00:00 16#00FF')).toEqual([
      T.TypedLiteral,
      T.TypedLiteral,
      T.TypedLiteral,
      T.TypedLiteral,
    ]);
    expect(kinds('%I0.0 %MW12')).toEqual([T.Address, T.Address]);
    expect(kinds('wire#w1')).toEqual([T.TypedLiteral]);
    expect(kinds('0..9')).toEqual([T.Number, T.Range, T.Number]);
  });
});

describe('SCL statements', () => {
  it('parses every control statement', () => {
    const file = sclBlock(
      '    IF #a > 1 THEN #i := 1; ELSIF #a < 0 THEN #i := 2; ELSE #i := 3; END_IF;',
      '    CASE #a OF 1, 3: #i := 1; 4..6: #i := 2; ELSE #i := 0; END_CASE;',
      '    FOR #i := 0 TO 9 BY 2 DO CONTINUE; END_FOR;',
      '    WHILE #i < 10 DO #i += 1; EXIT; END_WHILE;',
      '    REPEAT #i := #i - 1; UNTIL #i <= 0 END_REPEAT;',
      '    REGION My region',
      '        GOTO Done;',
      '    END_REGION',
      '    Done: RETURN;',
      '    ;',
    );
    expect(file.diagnostics).toEqual([]);
    const kinds = statements(file.blocks[0]!).map((s) => s.kind);
    expect(kinds).toEqual([
      'if',
      'case',
      'for',
      'while',
      'repeat',
      'region',
      'label',
      'return',
      'empty',
    ]);
    const caseStatement = statements(file.blocks[0]!)[1]!;
    expect(
      caseStatement.kind === 'case' && caseStatement.clauses.map((c) => c.labels.length),
    ).toEqual([2, 1]);
  });

  it('gives operators the SCL precedence', () => {
    const file = sclBlock('    #i := 1 + 2 * 3 > 4 AND NOT #a = 5 OR TRUE;');
    const s = statements(file.blocks[0]!)[0]!;
    expect(s.kind).toBe('assign');
    if (s.kind !== 'assign') return;
    expect(s.value.kind === 'binary' && s.value.op).toBe('OR');
  });

  it('parses calls with formal, output and positional parameters', () => {
    const file = sclBlock(
      '    #r := "FC_X"(InInt := #a, Out => #i, ENO => #ok);',
      '    #m := ABS(#a);',
      '    "IDB"(x := 1);',
    );
    expect(file.diagnostics).toEqual([]);
    const [a, b, c] = statements(file.blocks[0]!);
    expect(
      a!.kind === 'assign' && a!.value.kind === 'call' && a!.value.args.map((x) => x.direction),
    ).toEqual(['in', 'out', 'out']);
    expect(b!.kind === 'assign' && b!.value.kind === 'call' && b!.value.args[0]!.direction).toBe(
      'positional',
    );
    expect(c!.kind).toBe('callStatement');
  });

  it("reports a missing ';' on the statement's own line and recovers", () => {
    const file = sclBlock('    #i := 0', '    #i := 1;');
    expect(file.diagnostics.map((d) => d.code)).toEqual(['missing-semicolon']);
    expect(file.source.positionAt(file.diagnostics[0]!.range.start).line).toBe(9);
    expect(statements(file.blocks[0]!)).toHaveLength(2);
  });

  it('reports a missing END_IF', () => {
    const file = sclBlock('    IF #a > 0 THEN', '        #i := 1;');
    expect(file.diagnostics.some((d) => d.message.includes('END_IF'))).toBe(true);
  });

  it('keeps an unknown construct and marks it not analyzed, without an error', () => {
    const file = sclBlock('    @@weird stuff;', '    #i := 1;');
    expect(file.diagnostics.map((d) => d.severity)).toEqual(['info']);
    expect(file.notAnalyzed).toHaveLength(1);
    expect(statements(file.blocks[0]!).at(-1)!.kind).toBe('assign');
  });
});

describe('SIMATIC SD documents', () => {
  it('parses a unit FB with attributes, sections and an SCL network', () => {
    const file = parseBlockText(
      crlf(
        'NAMESPACE Filling',
        '    {',
        '        S7_EditorMode := "SCL";',
        '        S7_UnitAccess := "Published"',
        '    }',
        '    FUNCTION_BLOCK "FB_Filler"',
        '        VAR_INPUT',
        '            { S7_MLC := "MLC_I1" }',
        '            Start : Bool;',
        '        END_VAR',
        '        VAR',
        '            Doser : _.Dosing.FB_Doser;',
        '            Values : Array[0..9] of Real;',
        '        END_VAR',
        '',
        '        { S7_Language := "SCL" }',
        '        NETWORK',
        '            ',
        '                #Doser(Start := #Start);',
        '            ',
        '        END_NETWORK',
        '    END_FUNCTION_BLOCK',
        'END_NAMESPACE',
      ),
      's7dcl',
    );
    expect(file.diagnostics).toEqual([]);
    const block = file.blocks[0]!;
    expect([block.kind, block.name.text, block.namespace]).toEqual(['FB', 'FB_Filler', 'Filling']);
    expect(block.attributes.map((a) => [a.name, a.value])).toEqual([
      ['S7_EditorMode', 'SCL'],
      ['S7_UnitAccess', 'Published'],
    ]);
    expect(block.sections[0]!.members[0]!.attributes[0]!.value).toBe('MLC_I1');
    const doserType = block.sections[1]!.members[0]!.type;
    expect(
      doserType.kind === 'named' && [doserType.rooted, doserType.path.map((p) => p.text)],
    ).toEqual([true, ['Dosing', 'FB_Doser']]);
    expect(block.networks[0]!.language).toBe('SCL');
  });

  it('parses LAD rungs with branches, templates and boxes', () => {
    const file = parseBlockText(
      crlf(
        'FUNCTION "FC_L" : Void',
        '    {',
        '        S7_Language := "LAD";',
        '        S7_NetworkTitle := "MLC_N1T"',
        '    }',
        '    NETWORK',
        '        RUNG wire#powerrail',
        '            Contact( #Start )',
        '            wire#w1',
        '            { S7_Templates := "time_type := Time" }',
        '            #Delay.TON(',
        '                pt := T#3s,',
        '                et => #Elapsed',
        '            )',
        '            Coil( #Out )',
        '        END_RUNG',
        '        RUNG wire#w1',
        '            I_Contact( #Stop )',
        '        END_RUNG wire#w2',
        '    END_NETWORK',
        'END_FUNCTION',
      ),
      's7dcl',
    );
    expect(file.diagnostics).toEqual([]);
    const net = file.blocks[0]!.networks[0]!;
    expect(net.language).toBe('LAD');
    expect(net.titleId).toBe('MLC_N1T');
    const [r1, r2] = net.ladder!.rungs;
    expect(r1!.start.kind).toBe('powerrail');
    expect(r1!.items.map((i) => (i.kind === 'element' ? i.instruction : `wire ${i.name}`))).toEqual(
      ['Contact', 'wire w1', 'TON', 'Coil'],
    );
    const ton = r1!.items[2]!;
    expect(ton.kind === 'element' && ton.templates[0]!.value).toBe('time_type := Time');
    expect(r2!.start.kind === 'wire' && r2!.start.name).toBe('w1');
    expect(r2!.end?.name).toBe('w2');
  });

  it('parses FBD rungs that start at an operand, negated boxes and labels', () => {
    const file = parseBlockText(
      crlf(
        'FUNCTION "FC_F" : Void',
        '    { S7_Language := "FBD" }',
        '    NETWORK',
        '        Label(Skip)',
        '        RUNG #InA',
        '            NOT A( in2 := #InB )',
        '            Coil( #Out )',
        '        END_RUNG',
        '    END_NETWORK',
        'END_FUNCTION',
      ),
      's7dcl',
    );
    expect(file.diagnostics).toEqual([]);
    const ladder = file.blocks[0]!.networks[0]!.ladder!;
    expect(ladder.labels[0]!.name.text).toBe('Skip');
    expect(ladder.rungs[0]!.start.kind).toBe('operand');
    const first = ladder.rungs[0]!.items[0]!;
    expect(first.kind === 'element' && first.negated).toBe(true);
  });

  it('parses DBs with start values, instance DBs, array DBs and UDTs', () => {
    const db = parseBlockText(
      crlf(
        'DATA_BLOCK DB_M',
        '    VAR',
        '        Count : Int;',
        '    END_VAR',
        '',
        '    Count := 5;',
        '',
        'END_DATA_BLOCK',
      ),
      's7dcl',
    );
    expect(db.diagnostics).toEqual([]);
    expect(db.blocks[0]!.startValues).toHaveLength(1);
    const idb = parseBlockText(
      crlf('DATA_BLOCK IDB_X : FB_X', '    Mode := 2;', 'END_DATA_BLOCK'),
      's7dcl',
    );
    expect(idb.blocks[0]!.dbType?.kind).toBe('named');
    const adb = parseBlockText(
      crlf('DATA_BLOCK DB_R : Array[0..9] of _.UDT_R', 'END_DATA_BLOCK'),
      's7dcl',
    );
    expect(adb.blocks[0]!.dbType?.kind).toBe('array');
    const udt = parseBlockText(
      crlf(
        'TYPE',
        '    UDT_M : STRUCT',
        '        On : Bool := TRUE;',
        '    END_STRUCT;',
        'END_TYPE',
      ),
      's7dcl',
    );
    expect(udt.diagnostics).toEqual([]);
    expect(udt.blocks[0]!.struct!.members[0]!.initial?.kind).toBe('literal');
  });
});

describe('external sources', () => {
  it('reads the header, member attributes, comments and AT overlays', () => {
    const file = parseBlockText(
      crlf(
        '﻿FUNCTION "FC_A" : Byte',
        'TITLE = AT overlay',
        "{ S7_Optimized_Access := 'FALSE' }",
        'VERSION : 0.1',
        '//Block comment',
        '   VAR_TEMP ',
        '      RawWord : Word;   // Raw word',
        '      RawBytes AT RawWord : Array[0..1] of Byte;',
        "      Sp { S7_SetPoint := 'True'} : Real;",
        '   END_VAR',
        '',
        'BEGIN',
        '\t#FC_A := #RawBytes[0];',
        'END_FUNCTION',
        '',
      ),
      'source',
    );
    expect(file.diagnostics).toEqual([]);
    const block = file.blocks[0]!;
    expect(block.title?.text).toBe('AT overlay');
    expect(block.version).toBe('0.1');
    const [raw, bytes, sp] = block.sections[0]!.members;
    expect(raw!.comment?.text).toBe('Raw word');
    expect(bytes!.at?.text).toBe('RawWord');
    expect(sp!.attributes[0]!.name).toBe('S7_SetPoint');
  });

  it('reads instance and array DBs', () => {
    const idb = parseBlockText(
      crlf('DATA_BLOCK "IDB"', 'NON_RETAIN', '"FB_X"', '', 'BEGIN', '', 'END_DATA_BLOCK'),
      'source',
    );
    expect(idb.diagnostics).toEqual([]);
    expect(idb.blocks[0]!.dbType?.kind).toBe('named');
    const adb = parseBlockText(
      crlf('DATA_BLOCK "DB_R"', 'Array[0..9] of "UDT_R";', 'BEGIN', 'END_DATA_BLOCK'),
      'source',
    );
    expect(adb.blocks[0]!.dbType?.kind).toBe('array');
  });
});
