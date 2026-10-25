import { describe, expect, it } from 'vitest';
import { Project } from '../model/project.ts';
import { applyEdits } from '../writer/text-edit.ts';
import { completionsAt, signatureHelpAt } from './completion.ts';
import {
  codeLenses,
  foldingRanges,
  hoverAt,
  inlayHints,
  outline,
  quickFixes,
  semanticTokens,
} from './editor.ts';
import { definitionOf, referenceAt, referencesOf, renameEdits } from './navigation.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

const UDT = crlf(
  'TYPE',
  '    UDT_Motor : STRUCT',
  '        { S7_MLC := "MLC_1" }',
  '        Speed : Real;',
  '        On : Bool;',
  '    END_STRUCT;',
  'END_TYPE',
);
const UDT_RES = crlf(
  'MultiLingualTexts:',
  '  - id: MLC_1',
  '    de-DE: Drehzahl',
  '    en-US: Motor speed',
);

const FB = crlf(
  '{',
  '    S7_EditorMode := "SCL"',
  '}',
  'FUNCTION_BLOCK "FB_Main"',
  '    VAR',
  '        Motor : _.UDT_Motor;',
  '        Delay : TON_TIME;',
  '        Count : Int;',
  '    END_VAR',
  '    { S7_Language := "SCL" }',
  '    NETWORK',
  '        ',
  '            REGION Main',
  '                #Motor.Speed := 1.5;',
  '                #Delay(IN := #Motor.On, PT := T#2s);',
  '                #Count := ABS(#Count);',
  '                "FC_Calc"(In := #Count);',
  '            END_REGION',
  '        ',
  '    END_NETWORK',
  'END_FUNCTION_BLOCK',
);

const FC = crlf(
  '{',
  '    S7_EditorMode := "SCL"',
  '}',
  'FUNCTION "FC_Calc" : Void',
  '    VAR_INPUT',
  '        In : Int;',
  '        Gain : Real;',
  '    END_VAR',
  '    { S7_Language := "SCL" }',
  '    NETWORK',
  '        ',
  '            ;',
  '        ',
  '    END_NETWORK',
  'END_FUNCTION',
);

function setup(extra: Record<string, string> = {}) {
  const p = new Project('/plc');
  p.setManifest(
    '/plc/plc.json',
    JSON.stringify({
      name: 'P',
      cpu: { family: 'S7-1500' },
      tiaVersion: 'V21',
      displayLanguage: 'en-US',
      units: [],
    }),
  );
  const files: Record<string, string> = {
    'UDT_Motor.s7dcl': UDT,
    'UDT_Motor.s7res': UDT_RES,
    'FB_Main.s7dcl': FB,
    'FC_Calc.s7dcl': FC,
    ...extra,
  };
  for (const [n, t] of Object.entries(files)) p.setFileText(`/plc/${n}`, t);
  return p;
}

const offsetOf = (text: string, needle: string, delta = 0) => text.indexOf(needle) + delta;

describe('completion', () => {
  it('offers locals after #, members after a dot, globals after a quote', () => {
    const p = setup();
    const at = offsetOf(FB, '#Motor.Speed', 1);
    expect(completionsAt(p, '/plc/FB_Main.s7dcl', at).map((c) => c.label)).toEqual([
      'Motor',
      'Delay',
      'Count',
    ]);
    const dot = offsetOf(FB, '#Motor.Speed', 7);
    const members = completionsAt(p, '/plc/FB_Main.s7dcl', dot, 'de-DE');
    expect(members.map((c) => c.label)).toEqual(['Speed', 'On']);
    expect(members[0]!.documentation).toBe('Drehzahl');
    const timer = offsetOf(FB, '#Delay(', 7);
    const t = new Project('/x');
    void t;
    const quote = offsetOf(FB, '"FC_Calc"', 1);
    expect(completionsAt(p, '/plc/FB_Main.s7dcl', quote).map((c) => c.label)).toContain('FC_Calc');
    // inside a call: the parameters not given yet
    const inCall = offsetOf(FB, 'In := #Count);', 0);
    const params = completionsAt(p, '/plc/FB_Main.s7dcl', inCall);
    expect(params.map((c) => c.label)).toEqual(['In', 'Gain']);
    expect(timer).toBeGreaterThan(0);
  });

  it('gives signature help with the active parameter', () => {
    const p = setup();
    const at = offsetOf(FB, 'PT := T#2s', 0);
    const help = signatureHelpAt(p, '/plc/FB_Main.s7dcl', at)!;
    expect(help.signature.parameters.map((x) => x.name)).toEqual(['IN', 'PT', 'Q', 'ET']);
    expect(help.activeParameter).toBe(1);
  });
});

describe('hover, definition, references, rename', () => {
  it('hovers a UDT member with its type and comments in every language', () => {
    const p = setup();
    const hover = hoverAt(p, '/plc/FB_Main.s7dcl', offsetOf(FB, 'Speed :=', 1), 'en-US')!;
    expect(hover.contents).toContain('Real');
    expect(hover.contents).toContain('Motor speed');
    expect(hover.contents).toContain('de-DE');
  });

  it('finds the definition and every reference across files', () => {
    const p = setup();
    const ref = referenceAt(p, '/plc/FB_Main.s7dcl', offsetOf(FB, 'Speed :=', 1))!;
    expect(ref.symbolId).toBe('member:udt_motor/speed');
    expect(definitionOf(p, ref.symbolId)!.file).toBe('/plc/UDT_Motor.s7dcl');
    expect(referencesOf(p, ref.symbolId).map((r) => r.file)).toEqual([
      '/plc/UDT_Motor.s7dcl',
      '/plc/FB_Main.s7dcl',
    ]);
  });

  it('renames a block in every file, keeps the quotes and proposes file renames', () => {
    const p = setup();
    const result = renameEdits(p, 'block:fc_calc', 'FC_Compute');
    if ('error' in result) throw new Error(result.error);
    expect(applyEdits(FB, result.edits.get('/plc/FB_Main.s7dcl')!)).toContain(
      '"FC_Compute"(In := #Count);',
    );
    expect(applyEdits(FC, result.edits.get('/plc/FC_Calc.s7dcl')!)).toContain(
      'FUNCTION "FC_Compute" : Void',
    );
    expect(result.fileRenames).toEqual([
      { from: '/plc/FC_Calc.s7dcl', to: '/plc/FC_Compute.s7dcl' },
    ]);
  });

  it('refuses invalid names and name clashes', () => {
    const p = setup();
    expect(renameEdits(p, 'member:fb_main/count', 'Two words')).toMatchObject({
      error: expect.any(String),
    });
    expect(renameEdits(p, 'member:fb_main/count', 'Motor')).toMatchObject({
      error: expect.stringContaining('already declared'),
    });
  });
});

describe('quick fixes', () => {
  it('declares an undeclared variable in the right section with a guessed type', () => {
    const text = FB.replace('#Count := ABS(#Count);', '#Total := 2.5;');
    const p = setup({ 'FB_Main.s7dcl': text });
    const start = text.indexOf('#Total');
    const fixes = quickFixes(p, '/plc/FB_Main.s7dcl', {
      code: 'undeclared-local',
      message: '',
      range: { start, end: start + 6 },
    });
    expect(fixes.map((f) => f.title)).toEqual([
      'Declare #Total : Real in VAR_TEMP',
      'Declare #Total : Real in VAR',
      'Declare #Total : Real in VAR_INPUT',
      'Declare #Total : Real in VAR_OUTPUT',
    ]);
    const fixed = applyEdits(text, fixes[1]!.edits.get('/plc/FB_Main.s7dcl')!);
    expect(fixed).toContain('        Count : Int;\r\n        Total : Real;\r\n    END_VAR');
    const temp = applyEdits(text, fixes[0]!.edits.get('/plc/FB_Main.s7dcl')!);
    expect(temp).toContain(
      '    END_VAR\r\n    VAR_TEMP\r\n        Total : Real;\r\n    END_VAR\r\n',
    );
  });

  it('adds missing call parameters and wraps implicit conversions', () => {
    const p = setup();
    const call = 'FC_Calc"(In := #Count)';
    const start = FB.indexOf('"FC_Calc"');
    const fixes = quickFixes(p, '/plc/FB_Main.s7dcl', {
      code: 'missing-fc-parameter',
      message: '',
      range: { start, end: start + call.length + 1 },
    });
    expect(applyEdits(FB, fixes[0]!.edits.get('/plc/FB_Main.s7dcl')!)).toContain(
      '"FC_Calc"(In := #Count, Gain := 0.0);',
    );
    const conv = quickFixes(p, '/plc/FB_Main.s7dcl', {
      code: 'implicit-conversion',
      message: 'Implicit conversion from Real to Int may lose sign or precision.',
      range: { start: FB.indexOf('ABS(#Count)'), end: FB.indexOf('ABS(#Count)') + 11 },
    });
    expect(conv[0]!.title).toBe('Convert explicitly with REAL_TO_INT');
  });
});

describe('outline, folding, tokens, hints, lenses', () => {
  it('builds an outline with sections, members and regions', () => {
    const p = setup();
    const file = p.files.get('/plc/FB_Main.s7dcl')!.parsed!;
    if (file.kind !== 'blocks') throw new Error();
    const [block] = outline(file);
    expect(block!.name).toBe('FB_Main');
    expect(block!.children.map((c) => c.name)).toEqual(['VAR', 'Main']);
    expect(foldingRanges(file).length).toBeGreaterThan(3);
  });

  it('classifies identifiers and shows parameter names of non-formal calls', () => {
    const p = setup();
    const tokens = semanticTokens(p, '/plc/FB_Main.s7dcl');
    expect(
      tokens.some((t) => t.type === 'function' && t.modifiers.includes('defaultLibrary')),
    ).toBe(true);
    const hints = inlayHints(p, '/plc/FB_Main.s7dcl', 0, FB.length);
    expect(hints.map((h) => h.label)).toEqual(['IN:']);
    const lenses = codeLenses(p, '/plc/FC_Calc.s7dcl');
    expect(lenses[0]!.title).toBe('1 reference');
  });

  it("colors a local's # together with its name", () => {
    const tokens = semanticTokens(setup(), '/plc/FB_Main.s7dcl');
    const text = (t: (typeof tokens)[number]) => FB.slice(t.start, t.start + t.length);
    const kinds = new Map(tokens.map((t) => [text(t), t.type]));
    // used with '#': a variable of the block, whatever its section
    expect(kinds.get('#Motor')).toBe('variable');
    expect(kinds.get('#Count')).toBe('variable');
    // a member after '.', and a formal parameter where a call names it
    expect(kinds.get('Speed')).toBe('property');
    expect(kinds.get('In')).toBe('parameter');
  });
});
