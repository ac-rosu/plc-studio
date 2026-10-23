// A synthetic PLC of any size for the performance gates (spec: "5,000-block PLC indexed in under
// 10 s"). Generated in the forms TIA exports: SIMATIC SD documents, one file per object.

export interface SyntheticFile {
  readonly name: string;
  readonly text: string;
}

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

function udt(i: number): SyntheticFile {
  return {
    name: `UDT_Data${i}.s7dcl`,
    text: crlf([
      'TYPE',
      `    UDT_Data${i} : STRUCT`,
      '        On : Bool;',
      '        Speed : Real;',
      '        Count : Int;',
      '        Label : String[20];',
      '    END_STRUCT;',
      'END_TYPE',
    ]),
  };
}

function fc(i: number): SyntheticFile {
  return {
    name: `FC_Calc${i}.s7dcl`,
    text: crlf([
      '{',
      '    S7_EditorMode := "SCL";',
      '    S7_Optimized := "TRUE";',
      '    S7_Version := "0.1"',
      '}',
      `FUNCTION "FC_Calc${i}" : Real`,
      '    VAR_INPUT',
      '        Value : Real;',
      '        Gain : Real;',
      '    END_VAR',
      '    VAR_TEMP',
      '        Scaled : Real;',
      '    END_VAR',
      '    { S7_Language := "SCL" }',
      '    NETWORK',
      '        ',
      '            #Scaled := #Value * #Gain;',
      '            IF #Scaled > 100.0 THEN',
      '                #Scaled := 100.0;',
      '            END_IF;',
      `            #FC_Calc${i} := #Scaled;`,
      '        ',
      '    END_NETWORK',
      'END_FUNCTION',
    ]),
  };
}

function fb(i: number, udtCount: number, fcCount: number): SyntheticFile {
  const u = i % udtCount;
  const f = i % fcCount;
  const body: string[] = [];
  for (let r = 0; r < 4; r++) {
    body.push(
      `            REGION Step ${r}`,
      `                #Data.Speed := "FC_Calc${f}"(Value := #Data.Speed, Gain := 1.5);`,
      '                #Delay(IN := #Data.On, PT := T#2s);',
      '                CASE #State OF',
      '                    0:',
      '                        #State := 1;',
      '                    1:',
      '                        #Data.Count := #Data.Count + 1;',
      '                    ELSE',
      '                        #State := 0;',
      '                END_CASE;',
      '                FOR #Index := 0 TO 9 DO',
      '                    #Values[#Index] := #Values[#Index] * 2.0;',
      '                END_FOR;',
      '            END_REGION',
    );
  }
  return {
    name: `FB_Unit${i}.s7dcl`,
    text: crlf([
      '{',
      '    S7_EditorMode := "SCL";',
      '    S7_Optimized := "TRUE";',
      '    S7_Version := "0.1"',
      '}',
      `FUNCTION_BLOCK "FB_Unit${i}"`,
      '    VAR_INPUT',
      '        Enable : Bool;',
      '    END_VAR',
      '    VAR_OUTPUT',
      '        Done : Bool;',
      '    END_VAR',
      '    VAR_IN_OUT',
      `        Data : _.UDT_Data${u};`,
      '    END_VAR',
      '    VAR',
      '        State : Int;',
      '        Delay : TON_TIME;',
      '        Values : Array[0..9] of Real;',
      '    END_VAR',
      '    VAR_TEMP',
      '        Index : Int;',
      '    END_VAR',
      '    { S7_Language := "SCL" }',
      '    NETWORK',
      '        ',
      ...body,
      '            #Done := #Delay.Q;',
      '        ',
      '    END_NETWORK',
      'END_FUNCTION_BLOCK',
    ]),
  };
}

function idb(i: number): SyntheticFile {
  return {
    name: `IDB_Unit${i}.s7dcl`,
    text: crlf([
      '{',
      '    S7_Optimized := "TRUE";',
      '    S7_Version := "0.1"',
      '}',
      `DATA_BLOCK IDB_Unit${i} : FB_Unit${i}`,
      'END_DATA_BLOCK',
    ]),
  };
}

function db(i: number, udtCount: number): SyntheticFile {
  return {
    name: `DB_Data${i}.s7dcl`,
    text: crlf([
      '{',
      '    S7_Optimized := "TRUE";',
      '    S7_Version := "0.1"',
      '}',
      `DATA_BLOCK DB_Data${i}`,
      '    VAR',
      `        Item : _.UDT_Data${i % udtCount};`,
      '        Counter : DInt;',
      '    END_VAR',
      '',
      '    Counter := 0;',
      '',
      'END_DATA_BLOCK',
    ]),
  };
}

function ob(i: number, from: number, to: number): SyntheticFile {
  const calls: string[] = [];
  for (let k = from; k < to; k++)
    calls.push(`            "IDB_Unit${k}"(Enable := TRUE, Data := "DB_Data${k}".Item);`);
  return {
    name: `OB_Main${i}.s7dcl`,
    text: crlf([
      '{',
      '    S7_EditorMode := "SCL";',
      '    S7_Optimized := "TRUE";',
      '    S7_Version := "0.1"',
      '}',
      `ORGANIZATION_BLOCK "OB_Main${i}"`,
      '    { S7_Language := "SCL" }',
      '    NETWORK',
      '        ',
      ...calls,
      '        ',
      '    END_NETWORK',
      'END_ORGANIZATION_BLOCK',
    ]),
  };
}

/** About `blocks` objects: FBs with instance DBs and data DBs, FCs, UDTs and a few OBs. */
export function syntheticPlc(blocks: number): SyntheticFile[] {
  const units = Math.floor(blocks / 3.4);
  const udts = Math.max(1, Math.floor(units / 10));
  const fcs = Math.max(1, Math.floor(units / 5));
  const files: SyntheticFile[] = [];
  for (let i = 0; i < udts; i++) files.push(udt(i));
  for (let i = 0; i < fcs; i++) files.push(fc(i));
  for (let i = 0; i < units; i++) files.push(fb(i, udts, fcs), idb(i), db(i, udts));
  const perOb = 100;
  for (let o = 0; o * perOb < units; o++)
    files.push(ob(o, o * perOb, Math.min(units, (o + 1) * perOb)));
  files.push({
    name: 'plc.json',
    text: JSON.stringify({ name: 'Synthetic', cpu: { family: 'S7-1500' }, tiaVersion: 'V21' }),
  });
  return files;
}
