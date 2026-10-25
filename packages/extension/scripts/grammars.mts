// Generates the TextMate grammars, the language configuration, and in package.json the default
// token colors and the semantic token scopes. Run after changing keywords or colors:
// node scripts/grammars.mts
import { readFileSync, writeFileSync } from 'node:fs';
import {
  LIGHT_THEME_MARK,
  SYNTAX_COLORS,
  SYNTAX_ROLES,
  type SyntaxRole,
} from '../../core/src/syntax/colors.ts';
import { instructionNames } from '../../core/src/syntax/instruction-names.ts';
import {
  SCL_CONSTANT_WORDS,
  SCL_CONTROL_KEYWORDS,
  SCL_WORD_OPERATORS,
} from '../../core/src/syntax/keywords.ts';

// the instruction names come from the version profile (rule 6); V21 is the one profile
const v21Profile = JSON.parse(readFileSync('../profiles/V21/profile.json', 'utf8'));

const KW = SCL_CONTROL_KEYWORDS.join('|');
const BLOCK =
  'FUNCTION_BLOCK|END_FUNCTION_BLOCK|FUNCTION|END_FUNCTION|ORGANIZATION_BLOCK|END_ORGANIZATION_BLOCK|DATA_BLOCK|END_DATA_BLOCK|TYPE|END_TYPE|NAMESPACE|END_NAMESPACE|BEGIN|TITLE|VERSION|AUTHOR|FAMILY|NAME|NON_RETAIN|KNOW_HOW_PROTECT';
const DECL =
  'VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_STAT|VAR|END_VAR|CONSTANT|RETAIN|DB_SPECIFIC|STRUCT|END_STRUCT|ARRAY|AT|REF_TO';
const TYPES =
  'Bool|Byte|Word|DWord|LWord|SInt|USInt|Int|UInt|DInt|UDInt|LInt|ULInt|Real|LReal|Time|LTime|S5Time|Date|Time_Of_Day|TOD|LTime_Of_Day|LTOD|Date_And_Time|DT|LDT|DTL|Char|WChar|String|WString|Variant|DB_ANY|Void|Any|Pointer|TON_TIME|TOF_TIME|TP_TIME|TONR_TIME|IEC_TIMER|IEC_COUNTER|CTU_INT|CTU_DINT|CTD_INT|CTUD_INT|R_TRIG|F_TRIG';
const SCHEMA = 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json';

const comments = [
  { name: 'comment.line.double-slash.plcstudio', match: '//.*$' },
  { name: 'comment.block.plcstudio', begin: '\\(\\*', end: '\\*\\)' },
  { name: 'comment.block.plcstudio', begin: '/\\*', end: '\\*/' },
];
// Every literal is colored as one: a typed prefix (WSTRING#, INT#, BOOL#) belongs to its value, and
// time and date literals are numbers like 100 and 16#FF.
const strings = [
  {
    name: 'string.quoted.single.plcstudio',
    begin: "(?i)(?:\\b(?:WSTRING|STRING|WCHAR|CHAR)#)?'",
    end: "'|$",
    patterns: [{ name: 'constant.character.escape.plcstudio', match: '\\$.' }],
  },
  {
    name: 'constant.numeric.date-time.plcstudio',
    match:
      '(?i)\\b(?:T|TIME|LT|LTIME|S5T|S5TIME|D|DATE|TOD|TIME_OF_DAY|LTOD|LTIME_OF_DAY|DT|DATE_AND_TIME|LDT|DTL)#[-+0-9A-Za-z_.:]+',
  },
  {
    name: 'constant.numeric.plcstudio',
    match: '(?i)\\b(?:[A-Z_]+#)?(?:\\d+#[0-9A-F_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:E[-+]?\\d+)?)\\b',
  },
  {
    name: 'constant.language.plcstudio',
    match: `(?i)\\b(?:BOOL#)?(${SCL_CONSTANT_WORDS.join('|')})\\b`,
  },
];
// Names get on first paint the colors the language server's semantic tokens give them later in the
// default themes, so nothing changes color once the server has analyzed the file: locals, globals,
// members, formal parameters, declared names and type names.
const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const QUOTED = '"[^"\\r\\n]*"';
const TYPE_NAME = `${QUOTED}|_\\.${NAME}(?:\\.${NAME})*`;
const names = [
  { name: 'variable.other.local.plcstudio', match: `#(?:${QUOTED}|${NAME})` },
  { name: 'variable.other.global.plcstudio', match: `${QUOTED}|\\b_\\.${NAME}(?:\\.${NAME})*` },
  { name: 'variable.other.address.plcstudio', match: '%[A-Za-z]+[0-9.]*' },
  {
    // a member after a dot; not an instruction called on an instance (#Delay.TON( … )
    match: `(?<=[A-Za-z0-9_"\\]])(\\.)(${NAME})\\b(?!\\s*\\()`,
    captures: { 2: { name: 'variable.other.property.plcstudio' } },
  },
];
// Formal parameters of a call (Enable := …, Q => …) and of a LAD/FBD box (operand := …)
const formalParameter = {
  match: `(?<![#."\\w])(${NAME})\\s*(?=:=|=>)`,
  captures: { 1: { name: 'variable.parameter.plcstudio' } },
};
// The declared name of a member or parameter (Speed : Real;), and the type after the colon
const declaration = (scope: string) => [
  {
    match: `^\\s*(${QUOTED}|${NAME})(?=\\s*(?:\\{[^}]*\\}\\s*)?:(?!=))`,
    captures: { 1: { name: scope } },
  },
  {
    match: `(?i)(?:(:)(?!=)|\\b(of))\\s*(${TYPE_NAME})`,
    captures: {
      1: { name: 'keyword.operator.plcstudio' },
      2: { name: 'keyword.control.declaration.plcstudio' },
      3: { name: 'entity.name.type.plcstudio' },
    },
  },
];
const attributes = {
  name: 'meta.attribute.plcstudio',
  begin: '\\{',
  end: '\\}',
  beginCaptures: { 0: { name: 'punctuation.definition.attribute.plcstudio' } },
  endCaptures: { 0: { name: 'punctuation.definition.attribute.plcstudio' } },
  patterns: [
    { name: 'entity.other.attribute-name.plcstudio', match: '\\b[A-Za-z_][A-Za-z0-9_]*(?=\\s*:=)' },
    { name: 'string.quoted.double.plcstudio', match: '"[^"]*"' },
    { name: 'string.quoted.single.plcstudio', match: "'[^']*'" },
    { name: 'keyword.operator.plcstudio', match: ':=' },
  ],
};
// Every keyword is keyword.control.*, so a theme gives all of them one color, as TIA does. A REGION
// line, its title included, and END_REGION have a color of their own, as in TIA.
const keywords = [
  {
    match: '(?i)\\b(REGION)\\b(.*)$',
    captures: {
      1: { name: 'keyword.control.region.plcstudio' },
      2: { name: 'entity.name.section.region.plcstudio' },
    },
  },
  { name: 'keyword.control.region.plcstudio', match: '(?i)\\bEND_REGION\\b' },
  { name: 'keyword.control.plcstudio', match: `(?i)\\b(${KW})\\b` },
  { name: 'keyword.control.block.plcstudio', match: `(?i)\\b(${BLOCK})\\b` },
  { name: 'keyword.control.declaration.plcstudio', match: `(?i)\\b(${DECL})\\b` },
  {
    name: 'keyword.control.operator.plcstudio',
    match: `(?i)\\b(${SCL_WORD_OPERATORS.join('|')})\\b`,
  },
  { name: 'storage.type.plcstudio', match: `(?i)\\b(${TYPES})\\b` },
  { name: 'keyword.operator.plcstudio', match: ':=|=>|<=|>=|<>|\\*\\*|[-+*/<>=&^]' },
];
const block = (name: string) => ({ name: `keyword.control.${name}.plcstudio` });
// A declaration section ends at END_VAR; if that is missing, at the code or the end of the block
const SECTION_END = `(?i)\\b(END_VAR)\\b|(?=\\b(?i:BEGIN|NETWORK|END_FUNCTION_BLOCK|END_FUNCTION|END_ORGANIZATION_BLOCK|END_DATA_BLOCK|END_TYPE)\\b)`;
const memberDeclarations = (scope: string) => [
  { include: '#comments' },
  { include: '#attributes' },
  { include: '#strings' },
  { include: '#struct' },
  ...declaration(scope),
  { name: 'keyword.control.declaration.plcstudio', match: '(?i)\\bof\\b' },
  { include: '#names' },
  { include: '#keywords' },
];
// VAR CONSTANT included: a block's own constants are colored as tags (#ARM_1), as in TIA
const sections = [
  {
    begin:
      '(?i)\\b(VAR(?:_INPUT|_OUTPUT|_IN_OUT|_TEMP|_STAT)?)\\b(?:\\s+(CONSTANT|RETAIN|NON_RETAIN|DB_SPECIFIC))?',
    beginCaptures: { 1: block('declaration'), 2: block('declaration') },
    end: SECTION_END,
    endCaptures: { 1: block('declaration') },
    patterns: memberDeclarations('variable.other.declaration.plcstudio'),
  },
];
const struct = {
  begin: '(?i)\\b(STRUCT)\\b',
  beginCaptures: { 1: block('declaration') },
  end: '(?i)\\b(END_STRUCT)\\b',
  endCaptures: { 1: block('declaration') },
  patterns: memberDeclarations('variable.other.declaration.plcstudio'),
};
// Block headers name the block: FB, OB and PLC data type as types, FC as a function, DB as a global
const headers = [
  {
    match: `(?i)\\b(FUNCTION_BLOCK|ORGANIZATION_BLOCK|TYPE)\\s+(${QUOTED}|${NAME})`,
    captures: { 1: block('block'), 2: { name: 'entity.name.type.plcstudio' } },
  },
  {
    match: `(?i)\\b(FUNCTION)\\s+(${QUOTED}|${NAME})`,
    captures: { 1: block('block'), 2: { name: 'entity.name.function.plcstudio' } },
  },
  {
    match: `(?i)\\b(NAMESPACE)\\s+(${NAME}(?:\\.${NAME})*)`,
    captures: { 1: block('block'), 2: { name: 'entity.name.namespace.plcstudio' } },
  },
  {
    // a PLC data type in SIMATIC SD: TYPE, then "UDT_X : STRUCT" on the next line
    match: `^\\s*(${NAME})(?=\\s*:\\s*(?i:STRUCT)\\b)`,
    captures: { 1: { name: 'entity.name.type.plcstudio' } },
  },
];
// A data block: its name, the FB of an instance DB, and the members its start values set
const dataBlock = {
  begin: `(?i)\\b(DATA_BLOCK)\\s+(${QUOTED}|${NAME})(?:\\s*(:)\\s*(${TYPE_NAME}|${NAME}))?`,
  beginCaptures: {
    1: block('block'),
    2: { name: 'variable.other.global.plcstudio' },
    3: { name: 'keyword.operator.plcstudio' },
    4: { name: 'entity.name.type.plcstudio' },
  },
  end: '(?i)\\b(END_DATA_BLOCK)\\b',
  endCaptures: { 1: block('block') },
  patterns: [
    { include: '#comments' },
    { include: '#attributes' },
    { include: '#strings' },
    ...sections,
    { include: '#struct' },
    { match: `^\\s*(${QUOTED})\\s*$`, captures: { 1: { name: 'entity.name.type.plcstudio' } } },
    {
      match: `^\\s*(${NAME})(?=\\s*(?:[.\\[]|:=))`,
      captures: { 1: { name: 'variable.other.readwrite.plcstudio' } },
    },
    { include: '#names' },
    { include: '#keywords' },
  ],
};
// A call: an instruction of the profile (ABS, TON, INT_TO_REAL …) gets its color; a call of a block
// ("FC_X"(…), _.Lib.FC_X(…), a unit's own instance DB) stays plain text, as in TIA.
const known = instructionNames(v21Profile);
const alternatives = (list: readonly string[]) =>
  [...list].sort((a, b) => b.length - a.length).join('|');
const calls = [
  {
    name: 'support.function.plcstudio',
    match: `(?i)\\b(?:${alternatives(known.instructions)}|(?:${alternatives(known.types)})_TO_(?:${alternatives(known.types)}))(?=\\s*\\()`,
  },
  {
    match: `(${QUOTED}|\\b_\\.${NAME}(?:\\.${NAME})*|\\b${NAME}(?:\\.${NAME})*)(?=\\s*\\()`,
    captures: { 1: { name: 'meta.function-call.plcstudio' } },
  },
];
const code = [
  { include: '#comments' },
  { include: '#attributes' },
  { include: '#strings' },
  ...headers,
  dataBlock,
  ...sections,
  { include: '#struct' },
  formalParameter,
  { include: '#keywords' },
  ...calls,
  { include: '#names' },
];
const repository = {
  comments: { patterns: comments },
  strings: { patterns: strings },
  names: { patterns: names },
  keywords: { patterns: keywords },
  attributes,
  struct,
};
const ladder = [
  {
    name: 'keyword.control.network.plcstudio',
    match: '(?i)\\b(NETWORK|END_NETWORK|RUNG|END_RUNG)\\b',
  },
  { name: 'meta.wire.plcstudio', match: '(?i)\\bwire#[A-Za-z0-9_]+' },
  {
    name: 'entity.name.function.ladder.plcstudio',
    match:
      '\\b(Contact|I_Contact|P_Contact|N_Contact|Coil|I_Coil|S_Coil|R_Coil|P_Coil|N_Coil|[A-Z]{2}_Contact|Move|Add|Sub|Mul|Div|JumpCoil|Label|S_SR|S_RS|P_Trig|N_Trig|A|O|X)(?=\\s*\\()',
  },
];

const grammars: Record<string, object> = {
  'plcstudio-scl': {
    $schema: SCHEMA,
    name: 'SCL (PLC Studio)',
    scopeName: 'source.plcstudio-scl',
    patterns: code,
    repository,
  },
  'plcstudio-s7dcl': {
    $schema: SCHEMA,
    name: 'SD Document (PLC Studio)',
    scopeName: 'source.plcstudio-s7dcl',
    patterns: [...ladder, ...code],
    repository,
  },
  'plcstudio-s7res': {
    $schema: SCHEMA,
    name: 'SD Resources (PLC Studio)',
    scopeName: 'source.plcstudio-s7res',
    // the texts are comments and titles, and are colored as comments
    patterns: [
      { name: 'keyword.control.resources.plcstudio', match: '^MultiLingualTexts:' },
      {
        match: '^(\\s*-\\s*)(id)(:)\\s*(\\S+)',
        captures: {
          2: { name: 'entity.name.tag.id.plcstudio' },
          4: { name: 'constant.other.id.plcstudio' },
        },
      },
      {
        match: '^(\\s+)([a-z]{2,3}-[A-Za-z]{2,4})(:)\\s?(.*)$',
        captures: {
          2: { name: 'entity.name.tag.culture.plcstudio' },
          4: { name: 'comment.line.text.plcstudio' },
        },
      },
    ],
  },
  'plcstudio-tagtable': {
    $schema: SCHEMA,
    name: 'Tag Table (PLC Studio)',
    scopeName: 'text.xml.plcstudio-tagtable',
    patterns: [{ include: 'text.xml' }],
  },
  // SCL rebuilt from a SimaticML export (ADR 0014): colored like SCL, never sent to the checker
  'plcstudio-scl-readonly': {
    $schema: SCHEMA,
    name: 'SCL from SimaticML (PLC Studio)',
    scopeName: 'source.plcstudio-scl-readonly',
    patterns: [{ include: 'source.plcstudio-scl' }],
  },
};
for (const [name, grammar] of Object.entries(grammars)) {
  writeFileSync(`syntaxes/${name}.tmLanguage.json`, JSON.stringify(grammar, null, 2) + '\n');
}

// The scopes of each color role (core/syntax/colors.ts), light or dark as the theme is.
const ROLE_SCOPES: Record<SyntaxRole, string[]> = {
  keyword: [
    'keyword.control.plcstudio',
    'keyword.control.block.plcstudio',
    'keyword.control.declaration.plcstudio',
    'keyword.control.operator.plcstudio',
    'keyword.control.network.plcstudio',
    'keyword.control.resources.plcstudio',
    'storage.type.plcstudio',
    'constant.language.plcstudio',
  ],
  region: ['keyword.control.region.plcstudio', 'entity.name.section.region.plcstudio'],
  comment: [
    'comment.line.double-slash.plcstudio',
    'comment.block.plcstudio',
    'comment.line.text.plcstudio',
  ],
  operator: ['keyword.operator.plcstudio'],
  instruction: ['support.function.plcstudio', 'entity.name.function.ladder.plcstudio'],
  literal: [
    'string.quoted.single.plcstudio',
    'string.quoted.double.plcstudio',
    'constant.character.escape.plcstudio',
    'constant.numeric.plcstudio',
    'constant.numeric.date-time.plcstudio',
  ],
  // the constants of a tag table; a block's own constants are tags (#ARM_1), as in TIA
  constant: ['variable.other.constant.plcstudio'],
  tag: [
    'variable.other.local.plcstudio',
    'variable.other.global.plcstudio',
    'variable.other.address.plcstudio',
    'variable.other.property.plcstudio',
    'variable.other.readwrite.plcstudio',
    'variable.other.declaration.plcstudio',
    'entity.name.type.plcstudio',
    'entity.name.function.plcstudio',
    'entity.name.namespace.plcstudio',
    'constant.other.id.plcstudio',
  ],
  parameter: ['variable.parameter.plcstudio'],
  metadata: [
    'entity.other.attribute-name.plcstudio',
    'punctuation.definition.attribute.plcstudio',
    'meta.wire.plcstudio',
    'entity.name.tag.id.plcstudio',
    'entity.name.tag.culture.plcstudio',
  ],
};
// The language server's semantic tokens take the scope of the same role, so a name never changes
// color when the server has analyzed the file.
const SEMANTIC_SCOPES: Record<string, string[]> = {
  variable: ['variable.other.readwrite.plcstudio'],
  'variable.readonly': ['variable.other.readwrite.plcstudio'],
  enumMember: ['variable.other.constant.plcstudio'],
  parameter: ['variable.parameter.plcstudio'],
  'parameter.declaration': ['variable.other.declaration.plcstudio'],
  property: ['variable.other.property.plcstudio'],
  function: ['variable.other.global.plcstudio'],
  'function.defaultLibrary': ['support.function.plcstudio'],
  class: ['entity.name.type.plcstudio'],
  struct: ['entity.name.type.plcstudio'],
};
const manifestPath = 'package.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
// a color and no italic or bold: a theme's font styles would set apart names of the same role
const rules = (kind: 'light' | 'dark') =>
  SYNTAX_ROLES.map((role) => ({
    scope: ROLE_SCOPES[role],
    settings: { foreground: SYNTAX_COLORS[kind][role], fontStyle: '' },
  }));
// semantic token colors as well: a theme's own semantic colors would win over the scopes above
const LANGUAGES = ['plcstudio-scl', 'plcstudio-s7dcl'];
const roleOf = (scope: string) => SYNTAX_ROLES.find((role) => ROLE_SCOPES[role].includes(scope))!;
const semanticRules = (kind: 'light' | 'dark') =>
  Object.fromEntries(
    LANGUAGES.flatMap((language) =>
      Object.entries(SEMANTIC_SCOPES).map(([selector, [scope]]) => [
        `${selector}:${language}`,
        {
          foreground: SYNTAX_COLORS[kind][roleOf(scope!)],
          bold: false,
          italic: false,
          underline: false,
        },
      ]),
    ),
  );
// the dark set for every theme, the light set for themes whose id contains "Light"
const LIGHT = `[*${LIGHT_THEME_MARK}*]`;
manifest.contributes.configurationDefaults['editor.tokenColorCustomizations'] = {
  textMateRules: rules('dark'),
  [LIGHT]: { textMateRules: rules('light') },
};
manifest.contributes.configurationDefaults['editor.semanticTokenColorCustomizations'] = {
  rules: semanticRules('dark'),
  [LIGHT]: { rules: semanticRules('light') },
};
manifest.contributes.semanticTokenScopes = LANGUAGES.map((language) => ({
  language,
  scopes: SEMANTIC_SCOPES,
}));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const languageConfiguration = {
  comments: { lineComment: '//', blockComment: ['(*', '*)'] },
  brackets: [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
    { open: '(*', close: ' *)', notIn: ['string'] },
  ],
  surroundingPairs: [
    ['(', ')'],
    ['[', ']'],
    ["'", "'"],
    ['"', '"'],
  ],
  folding: { markers: { start: '^\\s*(?i:REGION)\\b', end: '^\\s*(?i:END_REGION)\\b' } },
  wordPattern: '(-?\\d*\\.\\d\\w*)|(#?"[^"]*")|(#?[A-Za-z_][A-Za-z0-9_]*)',
  indentationRules: {
    increaseIndentPattern:
      '(?i)^\\s*(.*\\b(THEN|DO|OF|ELSE|REPEAT|STRUCT)\\s*$|REGION\\b.*$|VAR(_INPUT|_OUTPUT|_IN_OUT|_TEMP|_STAT)?(\\s+(CONSTANT|RETAIN|NON_RETAIN))?\\s*$|BEGIN\\s*$|NETWORK\\s*$|RUNG\\b.*$)',
    decreaseIndentPattern: '(?i)^\\s*(END_\\w+|ELSIF\\b|ELSE\\b|UNTIL\\b)',
  },
};
writeFileSync('language-configuration.json', JSON.stringify(languageConfiguration, null, 2) + '\n');
