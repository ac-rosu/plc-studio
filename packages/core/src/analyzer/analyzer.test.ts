import { describe, expect, it } from 'vitest';
// the index registers the analyzer passes
import {
  analyzeProject,
  calledFrom,
  callTree,
  executionContext,
  Project,
  traceValue,
  Workspace,
} from '../index.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

interface Decl {
  input?: string[];
  output?: string[];
  inout?: string[];
  stat?: string[];
  temp?: string[];
  constant?: string[];
}

function sections(d: Decl): string[] {
  const out: string[] = [];
  const add = (kw: string, list: string[] | undefined) => {
    if (!list) return;
    out.push(`    ${kw}`, ...list.map((m) => `        ${m};`), '    END_VAR');
  };
  add('VAR_INPUT', d.input);
  add('VAR_OUTPUT', d.output);
  add('VAR_IN_OUT', d.inout);
  add('VAR', d.stat);
  add('VAR_TEMP', d.temp);
  add('VAR CONSTANT', d.constant);
  return out;
}

function block(
  kind: 'FB' | 'FC' | 'OB',
  name: string,
  d: Decl,
  body: string[],
  extraHeader: string[] = [],
): string {
  const keyword =
    kind === 'FB' ? 'FUNCTION_BLOCK' : kind === 'FC' ? 'FUNCTION' : 'ORGANIZATION_BLOCK';
  const end =
    kind === 'FB'
      ? 'END_FUNCTION_BLOCK'
      : kind === 'FC'
        ? 'END_FUNCTION'
        : 'END_ORGANIZATION_BLOCK';
  return crlf(
    '{',
    ...extraHeader,
    '    S7_EditorMode := "SCL"',
    '}',
    `${keyword} "${name}"${kind === 'FC' ? ' : Void' : ''}`,
    ...sections(d),
    '    { S7_Language := "SCL" }',
    '    NETWORK',
    '        ',
    ...body.map((l) => '            ' + l),
    '        ',
    '    END_NETWORK',
    end,
  );
}

const ob = (body: string[], name = 'OB_Main', d: Decl = {}) => block('OB', name, d, body);

function project(files: Record<string, string>, manifest: object = {}, rules?: object): Project {
  const p = new Project('/plc');
  p.setManifest(
    '/plc/plc.json',
    JSON.stringify({ name: 'P', cpu: { family: 'S7-1500' }, tiaVersion: 'V21', ...manifest }),
  );
  if (rules) p.setRules('/plc/plcstudio.rules.json', JSON.stringify(rules));
  for (const [name, text] of Object.entries(files)) p.setFileText(`/plc/${name}`, text);
  return p;
}

function found(
  p: Project,
  rule: string,
): { file: string; line: number; severity: string; message: string }[] {
  const out: { file: string; line: number; severity: string; message: string }[] = [];
  for (const [file, list] of analyzeProject(p).diagnostics) {
    const source = p.files.get(file)?.source;
    for (const d of list) {
      if (d.code === rule)
        out.push({
          file: file.split('/').pop()!,
          line: (source?.positionAt(d.range.start).line ?? 0) + 1,
          severity: d.severity,
          message: d.message,
        });
    }
  }
  return out;
}

const count = (p: Project, rule: string) => found(p, rule).length;

describe('single-block rules (failing and passing case each)', () => {
  it('timer, counter or edge instance called conditionally', () => {
    const bad = block('FB', 'FB_T', { input: ['En : Bool'], stat: ['Delay : TON_TIME'] }, [
      'IF #En THEN',
      '    #Delay(IN := TRUE, PT := T#1s);',
      'END_IF;',
    ]);
    const good = block('FB', 'FB_T', { input: ['En : Bool'], stat: ['Delay : TON_TIME'] }, [
      '#Delay(IN := #En, PT := T#1s);',
    ]);
    expect(count(project({ 'FB_T.s7dcl': bad }), 'timer-not-called-every-cycle')).toBe(1);
    expect(count(project({ 'FB_T.s7dcl': good }), 'timer-not-called-every-cycle')).toBe(0);
  });

  it('same instance called twice', () => {
    const bad = block('FB', 'FB_C', { stat: ['C : CTU_INT'] }, [
      '#C(CU := TRUE, R := FALSE, PV := 5);',
      '#C(CU := FALSE, R := FALSE, PV := 5);',
    ]);
    const good = block('FB', 'FB_C', { stat: ['C : CTU_INT'] }, [
      '#C(CU := TRUE, R := FALSE, PV := 5);',
    ]);
    expect(
      found(project({ 'FB_C.s7dcl': bad }), 'instance-called-twice').map((f) => f.line),
    ).toEqual([12]);
    expect(count(project({ 'FB_C.s7dcl': good }), 'instance-called-twice')).toBe(0);
  });

  it('Temp read before written, also when written on one branch only', () => {
    const d = { input: ['X : Int', 'S : Bool'], output: ['Y : Int'], temp: ['T : Int'] };
    expect(
      count(
        project({ 'FC_A.s7dcl': block('FC', 'FC_A', d, ['#Y := #T + #X;']) }),
        'temp-read-before-write',
      ),
    ).toBe(1);
    expect(
      count(
        project({
          'FC_A.s7dcl': block('FC', 'FC_A', d, ['IF #S THEN #T := 1; END_IF;', '#Y := #T;']),
        }),
        'temp-read-before-write',
      ),
    ).toBe(1);
    expect(
      count(
        project({
          'FC_A.s7dcl': block('FC', 'FC_A', d, [
            'IF #S THEN #T := 1; ELSE #T := 2; END_IF;',
            '#Y := #T;',
          ]),
        }),
        'temp-read-before-write',
      ),
    ).toBe(0);
    expect(
      count(
        project({ 'FC_A.s7dcl': block('FC', 'FC_A', d, ['#T := #X;', '#Y := #T;']) }),
        'temp-read-before-write',
      ),
    ).toBe(0);
  });

  it('FC output not written on every path, also through RETURN', () => {
    const d = { input: ['S : Bool'], output: ['Y : Int'] };
    expect(
      found(
        project({
          'FC_O.s7dcl': block('FC', 'FC_O', d, ['IF #S THEN', '    #Y := 1;', 'END_IF;']),
        }),
        'output-not-written-on-every-path',
      ).map((f) => f.line),
    ).toEqual([14]);
    expect(
      count(
        project({
          'FC_O.s7dcl': block('FC', 'FC_O', d, ['IF #S THEN RETURN; END_IF;', '#Y := 1;']),
        }),
        'output-not-written-on-every-path',
      ),
    ).toBe(1);
    expect(
      count(
        project({
          'FC_O.s7dcl': block('FC', 'FC_O', d, ['IF #S THEN #Y := 1; ELSE #Y := 2; END_IF;']),
        }),
        'output-not-written-on-every-path',
      ),
    ).toBe(0);
  });

  it('output assigned twice in one cycle, not across exclusive branches', () => {
    const d = { input: ['S : Bool'], output: ['Y : Bool'] };
    expect(
      count(
        project({ 'FB_D.s7dcl': block('FB', 'FB_D', d, ['#Y := #S;', '#Y := NOT #Y;']) }),
        'output-assigned-twice',
      ),
    ).toBe(1);
    expect(
      count(
        project({
          'FB_D.s7dcl': block('FB', 'FB_D', d, [
            'IF #S THEN #Y := TRUE; ELSE #Y := FALSE; END_IF;',
          ]),
        }),
        'output-assigned-twice',
      ),
    ).toBe(0);
  });

  it('write to an input', () => {
    expect(
      count(
        project({
          'FC_W.s7dcl': block('FC', 'FC_W', { input: ['V : Int'], output: ['Y : Int'] }, [
            '#V := #V * 2;',
            '#Y := #V;',
          ]),
        }),
        'write-to-input',
      ),
    ).toBe(1);
    expect(
      count(
        project({
          'FC_W.s7dcl': block('FC', 'FC_W', { input: ['V : Int'], output: ['Y : Int'] }, [
            '#Y := #V * 2;',
          ]),
        }),
        'write-to-input',
      ),
    ).toBe(0);
  });

  it('structured types on Input/Output instead of InOut', () => {
    const udt = crlf(
      'TYPE',
      '    UDT_R : STRUCT',
      '        A : Int;',
      '    END_STRUCT;',
      'END_TYPE',
    );
    expect(
      found(
        project({
          'UDT_R.s7dcl': udt,
          'FB_S.s7dcl': block('FB', 'FB_S', { input: ['R : _.UDT_R'] }, ['#R.A := 1;']),
        }),
        'structured-parameter-by-value',
      ).map((f) => f.severity),
    ).toEqual(['info']);
    expect(
      count(
        project({
          'UDT_R.s7dcl': udt,
          'FB_S.s7dcl': block('FB', 'FB_S', { inout: ['R : _.UDT_R'] }, ['#R.A := 1;']),
        }),
        'structured-parameter-by-value',
      ),
    ).toBe(0);
  });

  it('global DB and PLC tag access inside FB/FC, but not in OBs or F-blocks', () => {
    const tags = `<Document><SW.Tags.PlcTagTable ID="0"><AttributeList><Name>T</Name></AttributeList><ObjectList>
<SW.Tags.PlcTag ID="1"><AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%M0.0</LogicalAddress><Name>Run</Name></AttributeList></SW.Tags.PlcTag>
</ObjectList></SW.Tags.PlcTagTable></Document>`;
    const db = crlf(
      'DATA_BLOCK DB_G',
      '    VAR',
      '        Speed : Real;',
      '    END_VAR',
      'END_DATA_BLOCK',
    );
    const fb = block('FB', 'FB_G', { output: ['S : Real'] }, [
      '#S := "DB_G".Speed;',
      '"Run" := TRUE;',
    ]);
    const p = project({
      'T.xml': tags,
      'DB_G.s7dcl': db,
      'FB_G.s7dcl': fb,
      'OB_Main.s7dcl': ob(['"Run" := "DB_G".Speed > 1.0;', '"FB_G_Inst"();']),
    });
    expect(count(p, 'global-db-access-in-fb')).toBe(1);
    expect(count(p, 'plc-tag-access-in-fb')).toBe(1);
    const f = block(
      'FB',
      'FB_F',
      { output: ['S : Real'] },
      ['#S := "DB_G".Speed;'],
      ['    S7_Safety := "TRUE";'],
    );
    expect(count(project({ 'DB_G.s7dcl': db, 'FB_F.s7dcl': f }), 'global-db-access-in-fb')).toBe(0);
  });

  it('FOR counter changed through a reference, and used after the loop', () => {
    const d = { output: ['Total : Int'], stat: ['Index : Int'], temp: ['P : REF_TO Int'] };
    const bad = block('FB', 'FB_F', d, [
      '#P := REF(#Index);',
      'FOR #Index := 0 TO 9 DO',
      '    #P^ := 10;',
      'END_FOR;',
      '#Total := #Index;',
    ]);
    const p = project({ 'FB_F.s7dcl': bad });
    expect(found(p, 'for-counter-modified').map((f) => [f.line, f.severity])).toEqual([
      [19, 'warning'],
    ]);
    expect(count(p, 'for-counter-used-after-loop')).toBe(1);
    const good = block('FB', 'FB_F', d, [
      'FOR #Index := 0 TO 9 DO',
      '    #Total := #Index;',
      'END_FOR;',
      '#Index := 0;',
      '#Total := #Index;',
    ]);
    expect(
      count(project({ 'FB_F.s7dcl': good }), 'for-counter-modified') +
        count(project({ 'FB_F.s7dcl': good }), 'for-counter-used-after-loop'),
    ).toBe(0);
  });

  it('status of a system instruction not evaluated', () => {
    const d = { stat: ['Now : DTL'], temp: ['Ret : Int'], output: ['Ok : Bool'] };
    expect(
      count(
        project({ 'FB_N.s7dcl': block('FB', 'FB_N', d, ['#Ret := RD_LOC_T(OUT => #Now);']) }),
        'status-not-evaluated',
      ),
    ).toBe(1);
    expect(
      count(
        project({
          'FB_N.s7dcl': block('FB', 'FB_N', d, [
            '#Ret := RD_LOC_T(OUT => #Now);',
            '#Ok := #Ret = 0;',
          ]),
        }),
        'status-not-evaluated',
      ),
    ).toBe(0);
  });

  it('CASE without ELSE and REAL compared with =', () => {
    const d = { input: ['M : Int', 'L : Real'], output: ['C : Int'] };
    const p = project({
      'FC_K.s7dcl': block('FC', 'FC_K', d, [
        'CASE #M OF 1: #C := 1; END_CASE;',
        'IF #L = 1.5 THEN #C := 2; END_IF;',
      ]),
    });
    expect(count(p, 'case-without-else')).toBe(1);
    expect(count(p, 'real-compared-with-equal')).toBe(1);
    const q = project({
      'FC_K.s7dcl': block('FC', 'FC_K', d, [
        'CASE #M OF 1: #C := 1; ELSE #C := 0; END_CASE;',
        'IF #M = 1 THEN #C := 2; END_IF;',
      ]),
    });
    expect(count(q, 'case-without-else') + count(q, 'real-compared-with-equal')).toBe(0);
  });

  it('WHILE/REPEAT without a clear exit', () => {
    const d = { input: ['Go : Bool'], temp: ['I : Int'] };
    expect(
      count(
        project({
          'FC_L.s7dcl': block('FC', 'FC_L', d, ['WHILE #Go DO', '    #I := 1;', 'END_WHILE;']),
        }),
        'loop-without-exit',
      ),
    ).toBe(1);
    expect(
      count(
        project({
          'FC_L.s7dcl': block('FC', 'FC_L', d, [
            '#I := 0;',
            'WHILE #I < 10 DO',
            '    #I := #I + 1;',
            'END_WHILE;',
          ]),
        }),
        'loop-without-exit',
      ),
    ).toBe(0);
    expect(
      count(
        project({
          'FC_L.s7dcl': block('FC', 'FC_L', d, [
            'WHILE TRUE DO',
            '    IF #Go THEN EXIT; END_IF;',
            'END_WHILE;',
          ]),
        }),
        'loop-without-exit',
      ),
    ).toBe(0);
  });

  it('SIMATIC timers and counters', () => {
    expect(
      count(
        project({ 'FC_S.s7dcl': block('FC', 'FC_S', { output: ['Q : Bool'] }, ['#Q := %T1;']) }),
        'simatic-timer-counter',
      ),
    ).toBe(1);
    expect(
      count(
        project({ 'FC_S.s7dcl': block('FC', 'FC_S', { output: ['Q : Bool'] }, ['#Q := %M1.0;']) }),
        'simatic-timer-counter',
      ),
    ).toBe(0);
  });

  it('unreachable code and empty REGIONs', () => {
    const d = { output: ['Q : Bool'] };
    const p = project({
      'FC_U.s7dcl': block('FC', 'FC_U', d, [
        '#Q := TRUE;',
        'RETURN;',
        '#Q := FALSE;',
        'REGION Nothing',
        'END_REGION',
      ]),
    });
    expect(found(p, 'unreachable-code').map((f) => f.severity)).toEqual(['info']);
    expect(count(p, 'empty-region')).toBe(1);
    expect(
      count(
        project({
          'FC_U.s7dcl': block('FC', 'FC_U', d, ['REGION Set', '    #Q := TRUE;', 'END_REGION']),
        }),
        'empty-region',
      ),
    ).toBe(0);
  });

  it('complexity limits come from the rules file', () => {
    const fc = block('FC', 'FC_X', { input: ['A : Int'], output: ['Q : Int'] }, [
      'IF #A > 1 THEN #Q := 1; ELSIF #A > 2 THEN #Q := 2; ELSE #Q := 3; END_IF;',
    ]);
    expect(count(project({ 'FC_X.s7dcl': fc }), 'complexity')).toBe(0);
    expect(
      count(
        project(
          { 'FC_X.s7dcl': fc },
          {},
          { rules: { complexity: ['info', { maxCyclomatic: 2 }] } },
        ),
        'complexity',
      ),
    ).toBe(1);
  });

  it('timer instance kept in Temp', () => {
    expect(
      count(
        project({
          'FB_X.s7dcl': block('FB', 'FB_X', { temp: ['T : TON_TIME'] }, [
            '#T(IN := TRUE, PT := T#1s);',
          ]),
        }),
        'state-in-temp',
      ),
    ).toBe(1);
    expect(
      count(
        project({
          'FB_X.s7dcl': block('FB', 'FB_X', { stat: ['T : TON_TIME'] }, [
            '#T(IN := TRUE, PT := T#1s);',
          ]),
        }),
        'state-in-temp',
      ),
    ).toBe(0);
  });

  it('unused Temp, Static, constant, Input, Output, InOut', () => {
    const d = {
      input: ['UsedIn : Int', 'UnusedIn : Int'],
      output: ['Out : Int', 'NeverOut : Int'],
      inout: ['Io : Int'],
      stat: ['S : Int'],
      temp: ['T : Int'],
      constant: ['C : Int := 1'],
    };
    const p = project({ 'FB_U.s7dcl': block('FB', 'FB_U', d, ['#Out := #UsedIn;']) });
    for (const rule of [
      'unused-temp',
      'unused-static',
      'unused-constant',
      'unused-input',
      'unused-output',
      'unused-inout',
    ])
      expect(count(p, rule), rule).toBe(1);
    expect(found(p, 'unused-input')[0]!.severity).toBe('info');
    expect(found(p, 'unused-temp')[0]!.severity).toBe('warning');
  });
});

describe('cross-block rules', () => {
  const inner = block(
    'FB',
    'FB_Inner',
    { input: ['Start : Bool'], output: ['Done : Bool'], stat: ['Delay : TON_TIME'] },
    ['#Delay(IN := #Start, PT := T#2s);', '#Done := #Delay.Q;'],
  );

  it('FB with a timer called conditionally', () => {
    const caller = (body: string[]) =>
      block('FB', 'FB_Caller', { input: ['En : Bool'], stat: ['Inner : FB_Inner'] }, body);
    expect(
      count(
        project({
          'FB_Inner.s7dcl': inner,
          'FB_Caller.s7dcl': caller(['IF #En THEN', '    #Inner(Start := TRUE);', 'END_IF;']),
        }),
        'timer-fb-called-conditionally',
      ),
    ).toBe(1);
    expect(
      count(
        project({ 'FB_Inner.s7dcl': inner, 'FB_Caller.s7dcl': caller(['#Inner(Start := #En);']) }),
        'timer-fb-called-conditionally',
      ),
    ).toBe(0);
  });

  it('instance reached from OBs of different priority', () => {
    const idb = crlf('DATA_BLOCK IDB_Inner : FB_Inner', 'END_DATA_BLOCK');
    const files = {
      'FB_Inner.s7dcl': inner,
      'IDB_Inner.s7dcl': idb,
      'OB_Main.s7dcl': ob(['"IDB_Inner"(Start := TRUE);']),
      'OB_Fast.s7dcl': ob(['"IDB_Inner"(Start := FALSE);'], 'OB_Fast'),
    };
    const obs = {
      OB_Main: { type: 'ProgramCycle' },
      OB_Fast: { type: 'CyclicInterrupt', priority: 10, cycleTimeMs: 50 },
    };
    expect(count(project(files, { obs }), 'instance-shared-by-two-obs')).toBe(2);
    expect(
      count(
        project(files, {
          obs: { OB_Main: { type: 'ProgramCycle' }, OB_Fast: { type: 'ProgramCycle' } },
        }),
        'instance-shared-by-two-obs',
      ),
    ).toBe(0);
  });

  it('several writers, and data shared across priorities', () => {
    const tags = `<Document><SW.Tags.PlcTagTable ID="0"><AttributeList><Name>T</Name></AttributeList><ObjectList>
<SW.Tags.PlcTag ID="1"><AttributeList><DataTypeName>Int</DataTypeName><LogicalAddress>%MW0</LogicalAddress><Name>Level</Name></AttributeList></SW.Tags.PlcTag>
</ObjectList></SW.Tags.PlcTagTable></Document>`;
    const files = {
      'T.xml': tags,
      'OB_Main.s7dcl': ob(['"Level" := 1;']),
      'OB_Fast.s7dcl': ob(['IF "Level" > 0 THEN "Level" := 0; END_IF;'], 'OB_Fast'),
    };
    const p = project(files, {
      obs: {
        OB_Main: { type: 'ProgramCycle' },
        OB_Fast: { type: 'CyclicInterrupt', priority: 10 },
      },
    });
    expect(count(p, 'multiple-writers')).toBe(1);
    expect(count(p, 'unprotected-cross-priority-data')).toBe(1);
  });

  it('the same variable on two InOut parameters', () => {
    const fc = block('FC', 'FC_Swap', { inout: ['A : Int', 'B : Int'] }, ['#A := #B;']);
    const bad = ob(['"FC_Swap"(A := #X, B := #X);'], 'OB_Main', { temp: ['X : Int', 'Y : Int'] });
    const good = ob(['"FC_Swap"(A := #X, B := #Y);'], 'OB_Main', { temp: ['X : Int', 'Y : Int'] });
    expect(count(project({ 'FC_Swap.s7dcl': fc, 'OB_Main.s7dcl': bad }), 'inout-aliasing')).toBe(1);
    expect(count(project({ 'FC_Swap.s7dcl': fc, 'OB_Main.s7dcl': good }), 'inout-aliasing')).toBe(
      0,
    );
  });

  it('caller uses an FC output the FC does not always write', () => {
    const fc = block('FC', 'FC_P', { input: ['S : Bool'], output: ['R : Int'] }, [
      'IF #S THEN #R := 1; END_IF;',
    ]);
    const p = project({
      'FC_P.s7dcl': fc,
      'OB_Main.s7dcl': ob(['"FC_P"(S := TRUE, R => #V);'], 'OB_Main', { temp: ['V : Int'] }),
    });
    expect(count(p, 'unreliable-fc-output')).toBe(1);
  });

  it('recursion is a policy error that configuration cannot lower', () => {
    const self = block('FC', 'FC_R', { input: ['N : Int'] }, [
      'IF #N > 0 THEN "FC_R"(N := #N - 1); END_IF;',
    ]);
    const p = project(
      { 'FC_R.s7dcl': self, 'OB_Main.s7dcl': ob(['"FC_R"(N := 3);']) },
      {},
      { rules: { recursion: 'off' } },
    );
    expect(found(p, 'recursion').map((f) => f.severity)).toEqual(['error']);
    const a = block('FC', 'FC_A', {}, ['"FC_B"();']);
    const b = block('FC', 'FC_B', {}, ['"FC_A"();']);
    expect(count(project({ 'FC_A.s7dcl': a, 'FC_B.s7dcl': b }), 'recursion')).toBe(2);
    expect(
      count(
        project({
          'FC_A.s7dcl': block('FC', 'FC_A', {}, ['"FC_B"();']),
          'FC_B.s7dcl': block('FC', 'FC_B', {}, []),
        }),
        'recursion',
      ),
    ).toBe(0);
  });

  it('dead block, only when the export has OBs', () => {
    const fc = block('FC', 'FC_Dead', {}, []);
    expect(count(project({ 'FC_Dead.s7dcl': fc, 'OB_Main.s7dcl': ob([]) }), 'dead-block')).toBe(1);
    expect(
      count(project({ 'FC_Dead.s7dcl': fc, 'OB_Main.s7dcl': ob(['"FC_Dead"();']) }), 'dead-block'),
    ).toBe(0);
    expect(count(project({ 'FC_Dead.s7dcl': fc }), 'dead-block')).toBe(0);
  });
});

describe('configuration, custom rules, naming and suppression', () => {
  const fc = block('FC', 'FC_K', { input: ['M : Int'], output: ['C : Int'] }, [
    'CASE #M OF 1: #C := 1; END_CASE;',
  ]);

  it('severities: off, info; the PLC folder wins over the workspace', () => {
    expect(
      count(
        project({ 'FC_K.s7dcl': fc }, {}, { rules: { 'case-without-else': 'off' } }),
        'case-without-else',
      ),
    ).toBe(0);
    expect(
      found(
        project({ 'FC_K.s7dcl': fc }, {}, { rules: { 'case-without-else': 'info' } }),
        'case-without-else',
      ).map((f) => f.severity),
    ).toEqual(['info']);
    const w = new Workspace();
    w.setFileText(
      '/ws/plcstudio.rules.json',
      JSON.stringify({ rules: { 'case-without-else': 'off' } }),
    );
    w.setFileText(
      '/ws/plc/plc.json',
      JSON.stringify({ name: 'P', cpu: { family: 'S7-1500' }, tiaVersion: 'V21' }),
    );
    w.setFileText('/ws/plc/FC_K.s7dcl', fc);
    const p = w.projectFor('/ws/plc/FC_K.s7dcl');
    expect(count(p, 'case-without-else')).toBe(0);
    w.setFileText(
      '/ws/plc/plcstudio.rules.json',
      JSON.stringify({ rules: { 'case-without-else': 'warning' } }),
    );
    expect(count(p, 'case-without-else')).toBe(1);
  });

  it('custom rules: forbidden and required instructions, names, banned identifiers, comments, complexity, global access', () => {
    const body = block('FC', 'FC_Calc', { input: ['tmp : Real'], output: ['Y : Real'] }, [
      '#Y := ABS(#tmp);',
    ]);
    const rules = {
      custom: [
        {
          id: 'no-abs',
          kind: 'forbiddenInstruction',
          instruction: 'ABS',
          severity: 'warning',
          message: 'Use FC_Abs.',
        },
        {
          id: 'needs-limit',
          kind: 'requiredInstruction',
          instruction: 'LIMIT',
          in: ['FC'],
          severity: 'info',
        },
        {
          id: 'fc-name',
          kind: 'namePattern',
          target: 'FC',
          pattern: '^FC_[A-Z][a-z]+$',
          severity: 'info',
        },
        { id: 'no-tmp', kind: 'bannedIdentifier', identifiers: ['tmp'], severity: 'warning' },
        { id: 'member-comment', kind: 'requiredComment', target: 'Member', severity: 'info' },
        { id: 'tiny', kind: 'complexityLimit', maxCyclomatic: 0, severity: 'info' },
        { id: 'no-globals', kind: 'forbiddenGlobalAccess', severity: 'warning' },
      ],
    };
    const p = project({ 'FC_Calc.s7dcl': body }, {}, rules);
    expect(found(p, 'no-abs')[0]?.message).toContain('Use FC_Abs.');
    expect(count(p, 'needs-limit')).toBe(1);
    expect(count(p, 'fc-name')).toBe(0);
    expect(count(p, 'no-tmp')).toBe(1);
    expect(count(p, 'member-comment')).toBe(2);
    expect(count(p, 'tiny')).toBe(1);
    expect(count(p, 'no-globals')).toBe(0);
  });

  it('naming presets are off by default; default, siemens-prefix and match-workspace', () => {
    const fb = block(
      'FB',
      'MotorCtrl',
      { input: ['start : Bool'], constant: ['MaxSpeed : Int := 5'], stat: ['ErrCnt : Int'] },
      ['#ErrCnt := #MaxSpeed;'],
    );
    expect(count(project({ 'MotorCtrl.s7dcl': fb }), 'naming-convention')).toBe(0);
    const messages = found(
      project({ 'MotorCtrl.s7dcl': fb }, {}, { naming: { preset: 'default' } }),
      'naming-convention',
    ).map((f) => f.message);
    expect(messages.some((m) => m.includes('FB_'))).toBe(true);
    expect(messages.some((m) => m.includes('SCREAMING'))).toBe(true);
    expect(messages.some((m) => m.includes('"Error"') || m.includes('"Count"'))).toBe(true);
    const siemens = found(
      project({ 'MotorCtrl.s7dcl': fb }, {}, { naming: { preset: 'siemens-prefix' } }),
      'naming-convention',
    ).map((f) => f.message);
    expect(siemens.some((m) => m.includes('"in"'))).toBe(true);
    const members = ['inA : Int', 'inB : Int', 'inC : Int', 'inD : Int', 'Other : Int'];
    const mw = block('FB', 'FB_M', { input: members }, ['#Other := #inA + #inB + #inC + #inD;']);
    expect(
      found(
        project({ 'FB_M.s7dcl': mw }, {}, { naming: { preset: 'match-workspace' } }),
        'naming-convention',
      ).map((f) => f.message.split(' ')[0]),
    ).toEqual(['Other']);
  });

  it('inline suppression needs a reason and never hides errors', () => {
    const suppressed = block('FC', 'FC_K', { input: ['M : Int'], output: ['C : Int'] }, [
      '// plcstudio-disable-next-line case-without-else -- only mode 1 exists',
      'CASE #M OF 1: #C := 1; END_CASE;',
    ]);
    expect(count(project({ 'FC_K.s7dcl': suppressed }), 'case-without-else')).toBe(0);
    const noReason = block('FC', 'FC_K', { input: ['M : Int'], output: ['C : Int'] }, [
      '// plcstudio-disable-next-line case-without-else',
      'CASE #M OF 1: #C := 1; END_CASE;',
    ]);
    const p = project({ 'FC_K.s7dcl': noReason });
    expect(count(p, 'case-without-else')).toBe(1);
    expect(count(p, 'suppression-without-reason')).toBe(1);
    const rec = block('FC', 'FC_R', {}, ['// plcstudio-disable recursion -- testing', '"FC_R"();']);
    expect(count(project({ 'FC_R.s7dcl': rec }), 'recursion')).toBe(1);
  });
});

describe('call graph APIs', () => {
  const files = {
    'FB_Inner.s7dcl': block(
      'FB',
      'FB_Inner',
      { input: ['Start : Bool'], stat: ['Delay : TON_TIME'] },
      ['#Delay(IN := #Start, PT := T#2s);'],
    ),
    'IDB_Inner.s7dcl': crlf('DATA_BLOCK IDB_Inner : FB_Inner', 'END_DATA_BLOCK'),
    'FC_Helper.s7dcl': block('FC', 'FC_Helper', { input: ['V : Bool'], output: ['Q : Bool'] }, [
      '#Q := #V;',
    ]),
    'OB_Main.s7dcl': ob(
      [
        '"IDB_Inner"(Start := TRUE);',
        'FOR #I := 0 TO 3 DO',
        '    "FC_Helper"(V := #Flag, Q => #Flag);',
        'END_FOR;',
      ],
      'OB_Main',
      { temp: ['I : Int', 'Flag : Bool'] },
    ),
    'OB_Fast.s7dcl': ob(['IF TRUE THEN "FC_Helper"(V := FALSE, Q => #Out); END_IF;'], 'OB_Fast', {
      temp: ['Out : Bool'],
    }),
  };
  const obs = {
    OB_Main: { type: 'ProgramCycle', number: 1 },
    OB_Fast: { type: 'CyclicInterrupt', number: 35, priority: 12, cycleTimeMs: 100 },
  };

  it('builds the call tree with markers', () => {
    const tree = callTree(project(files, { obs }));
    expect(tree.map((n) => n.name)).toEqual(['OB_Fast', 'OB_Main']);
    const main = tree[1]!;
    expect(main.children.map((c) => [c.name, c.kind, c.instance, c.inLoop])).toEqual([
      ['FB_Inner', 'fb', 'IDB_Inner', false],
      ['FC_Helper', 'fc', undefined, true],
    ]);
    expect(main.children[0]!.children.map((c) => [c.name, c.kind])).toEqual([
      ['TON', 'instruction'],
    ]);
  });

  it('summarizes where a block runs', () => {
    const p = project(files, { obs });
    expect(calledFrom(p, 'block:fc_helper')).toBe(
      'OB_Fast (OB35, 100 ms) conditional; OB_Main (OB1) every cycle (in a loop)',
    );
    expect(executionContext(p, 'block:fb_inner')?.everyCycle).toBe(true);
    expect(calledFrom(p, 'block:ob_main')).toBe(
      'organization block (called by the operating system)',
    );
  });

  it('traces a value into and out of called blocks', () => {
    const p = project(files, { obs });
    const trace = traceValue(p, 'member:ob_main/flag');
    const ids = [...new Set(trace.map((t) => t.symbolId))];
    expect(ids).toContain('member:fc_helper/v');
    expect(ids).toContain('member:fc_helper/q');
    expect(trace.find((t) => t.symbolId === 'member:fc_helper/q')?.via[0]).toContain(
      'OB_Main → FC_Helper',
    );
  });
});
