// The TextMate grammars, tokenized with VS Code's own engine: every keyword in one family, names and
// literals in the scope of their color role, and every scope the grammars produce has a color in
// the defaults the extension contributes for VS Code's default themes.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LIGHT_THEME_MARK, SYNTAX_COLORS, SYNTAX_ROLES } from '@plcstudio/core';
import { beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const tm = require('vscode-textmate') as typeof import('vscode-textmate');
const onig = require('vscode-oniguruma') as typeof import('vscode-oniguruma');

const root = new URL('../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');
const manifest = JSON.parse(read('package.json'));

let registry: InstanceType<typeof tm.Registry>;
beforeAll(async () => {
  const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  registry = new tm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new onig.OnigScanner(patterns),
      createOnigString: (s: string) => new onig.OnigString(s),
    }),
    loadGrammar: async (scope: string) => {
      const name = scope.replace(/^source\./, '');
      return /^plcstudio-(scl|s7dcl|s7res)$/.test(name)
        ? tm.parseRawGrammar(read(`syntaxes/${name}.tmLanguage.json`), `${name}.json`)
        : null;
    },
  });
});

/** Each token of `text` with its innermost scope. */
async function tokenize(language: string, text: string): Promise<[string, string][]> {
  const grammar = (await registry.loadGrammar(`source.${language}`))!;
  let state = tm.INITIAL;
  const out: [string, string][] = [];
  for (const line of text.split('\n')) {
    const r = grammar.tokenizeLine(line, state);
    state = r.ruleStack;
    for (const t of r.tokens) {
      const word = line.slice(t.startIndex, t.endIndex);
      if (word.trim()) out.push([word.trim(), t.scopes.at(-1)!]);
    }
  }
  return out;
}
const scopeOf = (tokens: [string, string][], word: string) => tokens.find(([w]) => w === word)?.[1];

const SCL_SOURCE = [
  'FUNCTION_BLOCK "FB_Demo"',
  "{ S7_Optimized_Access := 'TRUE' }",
  'VERSION : 0.1',
  '   VAR_INPUT',
  '      Enable : Bool;   // Release',
  '   END_VAR',
  '   VAR',
  '      Motor : "UDT_Motor";',
  '      Delay : TON_TIME;',
  '   END_VAR',
  '   VAR CONSTANT',
  '      LIMIT : Int := 9;',
  '   END_VAR',
  'BEGIN',
  '   REGION Main',
  '      IF NOT #Enable AND #Motor.Running THEN',
  '         #Delay.TON(IN := TRUE, PT := T#2s);',
  '         "FC_Scale"(Value := 16#0F, Text := WSTRING#\'Ready\', Done => "DB_Log".Done);',
  '         #Motor.Speed := ABS(#LIMIT) + DINT_TO_INT(#Count);',
  '         OP_UnitStep(Mode := 1);',
  '         _.Library.FC_Area(Tool := 2);',
  '      END_IF;',
  '   END_REGION',
  'END_FUNCTION_BLOCK',
].join('\n');

describe('SCL grammar', () => {
  it('puts every keyword in one family, with REGION apart', async () => {
    const t = await tokenize('plcstudio-scl', SCL_SOURCE);
    for (const word of [
      'FUNCTION_BLOCK',
      'VAR_INPUT',
      'BEGIN',
      'IF',
      'NOT',
      'AND',
      'THEN',
      'END_IF',
    ])
      expect(scopeOf(t, word), word).toMatch(/^keyword\.control\.(\w+\.)?plcstudio$/);
    // the whole REGION line, its title included
    expect(scopeOf(t, 'REGION')).toBe('keyword.control.region.plcstudio');
    expect(scopeOf(t, 'Main')).toBe('entity.name.section.region.plcstudio');
    expect(scopeOf(t, 'END_REGION')).toBe('keyword.control.region.plcstudio');
    expect(scopeOf(t, 'TRUE')).toBe('constant.language.plcstudio');
  });

  it('colors names by role: tags, constants, members, formal parameters, instructions', async () => {
    const t = await tokenize('plcstudio-scl', SCL_SOURCE);
    expect(scopeOf(t, '"FB_Demo"')).toBe('entity.name.type.plcstudio');
    expect(scopeOf(t, 'Enable')).toBe('variable.other.declaration.plcstudio');
    // a block's own constant is a tag, as in TIA
    expect(scopeOf(t, 'LIMIT')).toBe('variable.other.declaration.plcstudio');
    expect(scopeOf(t, '"UDT_Motor"')).toBe('entity.name.type.plcstudio');
    expect(scopeOf(t, '#Enable')).toBe('variable.other.local.plcstudio');
    expect(scopeOf(t, 'Running')).toBe('variable.other.property.plcstudio');
    expect(scopeOf(t, 'TON')).toBe('support.function.plcstudio');
    expect(scopeOf(t, 'IN')).toBe('variable.parameter.plcstudio');
    expect(scopeOf(t, 'Value')).toBe('variable.parameter.plcstudio');
    expect(scopeOf(t, 'Done')).toBe('variable.parameter.plcstudio');
    // instructions of the profile get their color, a called block stays plain text
    expect(scopeOf(t, 'ABS')).toBe('support.function.plcstudio');
    expect(scopeOf(t, 'DINT_TO_INT')).toBe('support.function.plcstudio');
    expect(scopeOf(t, '"FC_Scale"')).toBe('meta.function-call.plcstudio');
    expect(scopeOf(t, 'OP_UnitStep')).toBe('meta.function-call.plcstudio');
    expect(scopeOf(t, '_.Library.FC_Area')).toBe('meta.function-call.plcstudio');
    expect(scopeOf(t, '"DB_Log"')).toBe('variable.other.global.plcstudio');
    expect(scopeOf(t, 'S7_Optimized_Access')).toBe('entity.other.attribute-name.plcstudio');
  });

  it('colors every literal as one, typed prefix included', async () => {
    const t = await tokenize('plcstudio-scl', SCL_SOURCE);
    expect(scopeOf(t, 'T#2s')).toBe('constant.numeric.date-time.plcstudio');
    expect(scopeOf(t, '16#0F')).toBe('constant.numeric.plcstudio');
    expect(scopeOf(t, 'TRUE')).toBe('constant.language.plcstudio');
    expect(t.find(([w]) => w.startsWith("WSTRING#'"))?.[1]).toBe('string.quoted.single.plcstudio');
  });

  it('marks the members a data block start value sets', async () => {
    const t = await tokenize(
      'plcstudio-scl',
      [
        'DATA_BLOCK "DB_Machine"',
        '   VAR',
        '      Limits : Struct',
        '         Minimum : Real;',
        '      END_STRUCT;',
        '   END_VAR',
        'BEGIN',
        '   MachineOn := FALSE;',
        '   LastStart.YEAR := 2026;',
        'END_DATA_BLOCK',
      ].join('\n'),
    );
    expect(scopeOf(t, '"DB_Machine"')).toBe('variable.other.global.plcstudio');
    expect(scopeOf(t, 'Minimum')).toBe('variable.other.declaration.plcstudio');
    expect(scopeOf(t, 'MachineOn')).toBe('variable.other.readwrite.plcstudio');
    expect(scopeOf(t, 'LastStart')).toBe('variable.other.readwrite.plcstudio');
    expect(scopeOf(t, 'YEAR')).toBe('variable.other.property.plcstudio');
  });
});

describe('SIMATIC SD grammar', () => {
  it('colors LAD rungs, SD type names and names outside a unit', async () => {
    const t = await tokenize(
      'plcstudio-s7dcl',
      [
        'TYPE',
        '    UDT_Point : STRUCT',
        '        X : Real;',
        '    END_STRUCT;',
        'END_TYPE',
        'FUNCTION_BLOCK "FB_Lad"',
        '    VAR',
        '        Motor : _.UDT_Motor;',
        '    END_VAR',
        '    NETWORK',
        '        RUNG wire#powerrail',
        '            Contact( #Start )',
        '            Move(',
        '                in := _.FlowRaw,',
        '                out1 => #Copy',
        '            )',
        '        END_RUNG',
        '    END_NETWORK',
        'END_FUNCTION_BLOCK',
      ].join('\n'),
    );
    expect(scopeOf(t, 'UDT_Point')).toBe('entity.name.type.plcstudio');
    expect(scopeOf(t, '_.UDT_Motor')).toBe('entity.name.type.plcstudio');
    expect(scopeOf(t, 'RUNG')).toBe('keyword.control.network.plcstudio');
    expect(scopeOf(t, 'wire#powerrail')).toBe('meta.wire.plcstudio');
    expect(scopeOf(t, 'Contact')).toBe('entity.name.function.ladder.plcstudio');
    expect(scopeOf(t, 'in')).toBe('variable.parameter.plcstudio');
    expect(scopeOf(t, '_.FlowRaw')).toBe('variable.other.global.plcstudio');
  });
});

describe('contributed colors', () => {
  const defaults = manifest.contributes.configurationDefaults;
  const custom = defaults['editor.tokenColorCustomizations'];
  // the dark set for every theme, the light set for themes whose id contains "Light"
  const light = `[*${LIGHT_THEME_MARK}*]`;
  const colored = (kind: 'light' | 'dark') =>
    new Map<string, string>(
      (kind === 'light' ? custom[light] : custom).textMateRules.flatMap(
        (r: { scope: string[]; settings: { foreground: string } }) =>
          r.scope.map((s) => [s, r.settings.foreground] as const),
      ),
    );

  it('give each role its palette color, light or dark as the theme is', () => {
    for (const kind of ['light', 'dark'] as const) {
      const colors = new Set(colored(kind).values());
      expect([...colors].sort()).toEqual(SYNTAX_ROLES.map((r) => SYNTAX_COLORS[kind][r]).sort());
    }
  });

  it("color the language server's tokens alike, over a theme's own semantic colors", () => {
    const semantic = defaults['editor.semanticTokenColorCustomizations'];
    for (const kind of ['light', 'dark'] as const) {
      const rules: Record<string, { foreground: string; italic: boolean; bold: boolean }> =
        kind === 'light' ? semantic[light].rules : semantic.rules;
      const tm = colored(kind);
      for (const { language, scopes } of manifest.contributes.semanticTokenScopes)
        for (const [selector, [scope]] of Object.entries(scopes) as [string, string[]][]) {
          const rule = rules[`${selector}:${language}`]!;
          expect(rule.foreground, `${kind} ${selector}`).toBe(tm.get(scope!));
          // no theme italics or bold: names of one role look alike
          expect([rule.italic, rule.bold]).toEqual([false, false]);
        }
    }
  });

  it('color every scope the grammars produce on corpus files', async () => {
    const corpus = new URL('../../../corpus/V21/', import.meta.url);
    const files = [
      ['plcstudio-scl', 'C05-scl-sections/source/FB_SclSections.scl'],
      ['plcstudio-scl', 'C08-scl-calls/source/FB_SclCalls.scl'],
      ['plcstudio-scl', 'C02-global-db/source/DB_Machine.db'],
      ['plcstudio-scl', 'C01-udts/source/UDT_Motor.udt'],
      ['plcstudio-s7dcl', 'C17-lad-boxes/documents/FB_LadBoxes.s7dcl'],
      ['plcstudio-s7dcl', 'C20-fbd-boxes/documents/FB_FbdBoxes.s7dcl'],
      ['plcstudio-s7dcl', 'C02-global-db/documents/DB_Machine.s7dcl'],
      ['plcstudio-s7res', 'C16-lad-contacts/documents/FC_LadContacts.s7res'],
    ];
    const known = colored('light');
    const uncolored = new Set<string>();
    for (const [language, file] of files) {
      const text = readFileSync(new URL(file!, corpus), 'utf8').replace(/\r\n/g, '\n');
      for (const [, scope] of await tokenize(language!, text))
        if (
          scope.endsWith('.plcstudio') &&
          !scope.startsWith('meta.attribute') &&
          !scope.startsWith('meta.function-call') &&
          !known.has(scope)
        )
          uncolored.add(scope);
    }
    expect([...uncolored]).toEqual([]);
  });

  it('map the semantic tokens to the scopes of the same roles', () => {
    const known = colored('dark');
    for (const { language, scopes } of manifest.contributes.semanticTokenScopes) {
      expect(['plcstudio-scl', 'plcstudio-s7dcl']).toContain(language);
      for (const list of Object.values(scopes) as string[][])
        for (const s of list) expect(known.has(s), s).toBe(true);
    }
  });
});
