// The SCL words an editor colors: control keywords, word operators and constant words. One list for
// the TextMate grammars (extension/scripts/grammars.mts) and the SCL preview in the LAD/FBD view.

export const SCL_CONTROL_KEYWORDS = [
  'IF',
  'THEN',
  'ELSIF',
  'ELSE',
  'END_IF',
  'CASE',
  'OF',
  'END_CASE',
  'FOR',
  'TO',
  'BY',
  'DO',
  'END_FOR',
  'WHILE',
  'END_WHILE',
  'REPEAT',
  'UNTIL',
  'END_REPEAT',
  'EXIT',
  'CONTINUE',
  'RETURN',
  'GOTO',
  'REGION',
  'END_REGION',
] as const;

export const SCL_WORD_OPERATORS = ['AND', 'OR', 'XOR', 'NOT', 'MOD'] as const;

export const SCL_CONSTANT_WORDS = ['TRUE', 'FALSE', 'NULL'] as const;
