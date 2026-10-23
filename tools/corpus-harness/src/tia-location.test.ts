import { describe, expect, it } from 'vitest';
import type { CompileMessage } from './expected.ts';
import { matchesLocation, messageLocation, tiaLocation } from './tia-location.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

const SCL_SOURCE = crlf(
  'FUNCTION "FC_X" : Void', // 1
  'VAR_TEMP', //               2
  '   a : Int;', //            3
  'END_VAR', //                4
  '', //                       5
  'BEGIN', //                  6
  '\t', //                     7  TIA line 1
  '\t#a := 1;', //             8  TIA line 2
  'END_FUNCTION', //           9
);

const SCL_DOCUMENT = crlf(
  '{', //                              1
  '    S7_EditorMode := "SCL";', //    2
  '    S7_Version := "0.1"', //        3
  '}', //                              4
  'FUNCTION FC_X : Void', //           5
  '    { S7_Language := "SCL" }', //   6
  '    NETWORK', //                    7
  '        ', //                       8  TIA line 1
  '        #a := 1;', //               9  TIA line 2
  '    END_NETWORK', //                10
  'END_FUNCTION', //                   11
);

const LAD_DOCUMENT = crlf(
  '{', //                              1
  '    S7_PreferredLanguage := "LAD"', // 2
  '}', //                              3
  'FUNCTION FC_L : Void', //           4
  '    NETWORK', //                    5  network 1
  '        RUNG wire#powerrail', //    6
  '        END_RUNG', //               7
  '    END_NETWORK', //                8
  '    { S7_Language := "SCL" }', //   9
  '    NETWORK', //                    10 network 2
  '        #a := 1;', //               11
  '    END_NETWORK', //                12
  'END_FUNCTION', //                   13
);

const message = (overrides: Partial<CompileMessage>): CompileMessage => ({
  severity: 'Error',
  path: 'PLC_Main > Program blocks > FC_X (FC1)',
  block: 'FC_X',
  line: null,
  network: null,
  description: '',
  ...overrides,
});

describe('tiaLocation', () => {
  it('counts external-source lines from BEGIN', () => {
    expect(tiaLocation(SCL_SOURCE, 7, '.scl')).toEqual({ kind: 'line', line: 1 });
    expect(tiaLocation(SCL_SOURCE, 8, '.scl')).toEqual({ kind: 'line', line: 2 });
  });

  it('puts declarations of external sources in the interface', () => {
    expect(tiaLocation(SCL_SOURCE, 3, '.scl')).toEqual({ kind: 'interface' });
    expect(tiaLocation(SCL_SOURCE, 6, '.scl')).toEqual({ kind: 'interface' });
    expect(tiaLocation('TYPE "U"\r\nEND_TYPE\r\n', 1, '.udt')).toEqual({ kind: 'interface' });
  });

  it('counts SCL lines of a SIMATIC SD document from NETWORK', () => {
    expect(tiaLocation(SCL_DOCUMENT, 8, '.s7dcl')).toEqual({ kind: 'line', line: 1 });
    expect(tiaLocation(SCL_DOCUMENT, 9, '.s7dcl')).toEqual({ kind: 'line', line: 2 });
    expect(tiaLocation(SCL_DOCUMENT, 2, '.s7dcl')).toEqual({ kind: 'interface' });
  });

  it('gives networks, not lines, in LAD/FBD blocks, also for their SCL networks', () => {
    expect(tiaLocation(LAD_DOCUMENT, 5, '.s7dcl')).toEqual({ kind: 'network', network: 1 });
    expect(tiaLocation(LAD_DOCUMENT, 6, '.s7dcl')).toEqual({ kind: 'network', network: 1 });
    expect(tiaLocation(LAD_DOCUMENT, 11, '.s7dcl')).toEqual({ kind: 'network', network: 2 });
    expect(tiaLocation(LAD_DOCUMENT, 2, '.s7dcl')).toEqual({ kind: 'interface' });
  });
});

describe('messageLocation and matchesLocation', () => {
  it('reads line, network, interface and block messages', () => {
    expect(messageLocation(message({ line: 3 }))).toEqual({ kind: 'line', line: 3 });
    expect(messageLocation(message({ network: 2 }))).toEqual({ kind: 'network', network: 2 });
    expect(messageLocation(message({ path: 'PLC_Main > DB_X (DB1) > Interface' }))).toEqual({
      kind: 'interface',
    });
    expect(messageLocation(message({}))).toEqual({ kind: 'block' });
  });

  it('matches only the same location; a block message matches anywhere', () => {
    expect(matchesLocation({ kind: 'line', line: 3 }, { kind: 'line', line: 3 })).toBe(true);
    expect(matchesLocation({ kind: 'line', line: 3 }, { kind: 'line', line: 4 })).toBe(false);
    expect(matchesLocation({ kind: 'network', network: 1 }, { kind: 'line', line: 1 })).toBe(false);
    expect(matchesLocation({ kind: 'interface' }, { kind: 'interface' })).toBe(true);
    expect(matchesLocation({ kind: 'block' }, { kind: 'network', network: 9 })).toBe(true);
  });
});
