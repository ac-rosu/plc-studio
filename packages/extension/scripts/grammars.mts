// Generates the TextMate grammars and the language configuration. Run after changing keywords:
// node scripts/grammars.mts
import { writeFileSync } from 'node:fs';
import {
  SCL_CONSTANT_WORDS,
  SCL_CONTROL_KEYWORDS,
  SCL_WORD_OPERATORS,
} from '../../core/src/syntax/keywords.ts';

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
const strings = [
  {
    name: 'string.quoted.single.plcstudio',
    begin: "'",
    end: "'|$",
    patterns: [{ name: 'constant.character.escape.plcstudio', match: '\\$.' }],
  },
  {
    name: 'constant.other.typed-literal.plcstudio',
    match:
      '(?i)\\b(?:T|TIME|LT|LTIME|S5T|S5TIME|D|DATE|TOD|TIME_OF_DAY|LTOD|DT|DATE_AND_TIME|LDT|DTL)#[-+0-9A-Za-z_.:]+',
  },
  {
    name: 'constant.numeric.plcstudio',
    match: '(?i)\\b(?:[A-Z_]+#)?(?:\\d+#[0-9A-F_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:E[-+]?\\d+)?)\\b',
  },
  { name: 'constant.language.plcstudio', match: `(?i)\\b(${SCL_CONSTANT_WORDS.join('|')})\\b` },
];
const names = [
  { name: 'variable.other.local.plcstudio', match: '#(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)' },
  { name: 'variable.other.global.plcstudio', match: '"[^"\\r\\n]*"' },
  { name: 'variable.other.address.plcstudio', match: '%[A-Za-z]+[0-9.]*' },
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
const code = [
  { include: '#comments' },
  { include: '#attributes' },
  { include: '#strings' },
  { include: '#names' },
  { name: 'keyword.control.plcstudio', match: `(?i)\\b(${KW})\\b` },
  { name: 'keyword.other.block.plcstudio', match: `(?i)\\b(${BLOCK})\\b` },
  { name: 'keyword.other.declaration.plcstudio', match: `(?i)\\b(${DECL})\\b` },
  { name: 'keyword.operator.word.plcstudio', match: `(?i)\\b(${SCL_WORD_OPERATORS.join('|')})\\b` },
  { name: 'storage.type.plcstudio', match: `(?i)\\b(${TYPES})\\b` },
  { name: 'keyword.operator.plcstudio', match: ':=|=>|<=|>=|<>|\\*\\*|[-+*/<>=&^]' },
  { name: 'support.function.plcstudio', match: '\\b[A-Za-z_][A-Za-z0-9_]*(?=\\s*\\()' },
];
const repository = {
  comments: { patterns: comments },
  strings: { patterns: strings },
  names: { patterns: names },
  attributes,
};
const ladder = [
  {
    name: 'keyword.other.network.plcstudio',
    match: '(?i)\\b(NETWORK|END_NETWORK|RUNG|END_RUNG)\\b',
  },
  { name: 'entity.name.tag.wire.plcstudio', match: '(?i)\\bwire#[A-Za-z0-9_]+' },
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
    patterns: [
      { name: 'keyword.other.plcstudio', match: '^MultiLingualTexts:' },
      {
        match: '^(\\s*-\\s*)(id)(:)\\s*(\\S+)',
        captures: {
          2: { name: 'entity.name.tag.plcstudio' },
          4: { name: 'constant.other.id.plcstudio' },
        },
      },
      {
        match: '^(\\s+)([a-z]{2,3}-[A-Za-z]{2,4})(:)\\s?(.*)$',
        captures: {
          2: { name: 'entity.name.tag.culture.plcstudio' },
          4: { name: 'string.unquoted.plcstudio' },
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
};
for (const [name, grammar] of Object.entries(grammars)) {
  writeFileSync(`syntaxes/${name}.tmLanguage.json`, JSON.stringify(grammar, null, 2) + '\n');
}

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
