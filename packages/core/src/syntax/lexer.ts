// One lexer for SIMATIC SD documents and external sources. Every character of the input belongs
// to exactly one token, trivia included, so concatenating the tokens gives the input back.

/** Token kinds. Trivia kinds come first (see isTrivia). */
export const T = {
  Whitespace: 0,
  Newline: 1,
  LineComment: 2,
  BlockComment: 3,
  Identifier: 4,
  /** "..." : a quoted identifier, or a string value inside an attribute block. */
  Quoted: 5,
  /** '...' */
  String: 6,
  Number: 7,
  /** T#1s, INT#5, 16#FF, WSTRING#'x', wire#w1 ... */
  TypedLiteral: 8,
  /** %I0.0, %MW12, %DB1.DBX0.0 */
  Address: 9,
  Hash: 10,
  Assign: 11, // :=
  Output: 12, // =>
  Range: 13, // ..
  Le: 14, // <=
  Ge: 15, // >=
  Ne: 16, // <>
  Power: 17, // **
  PlusAssign: 18, // +=
  MinusAssign: 19, // -=
  TimesAssign: 20, // *=
  DivAssign: 21, // /=
  Plus: 22,
  Minus: 23,
  Star: 24,
  Slash: 25,
  Lt: 26,
  Gt: 27,
  Eq: 28,
  LParen: 29,
  RParen: 30,
  LBracket: 31,
  RBracket: 32,
  LBrace: 33,
  RBrace: 34,
  Comma: 35,
  Semicolon: 36,
  Colon: 37,
  Dot: 38,
  Caret: 39,
  Ampersand: 40,
  Unknown: 41,
  EOF: 42,
} as const;
export type T = (typeof T)[keyof typeof T];

export interface Token {
  readonly kind: T;
  readonly start: number;
  readonly end: number;
}

export function isTrivia(kind: T): boolean {
  return kind <= T.BlockComment;
}

const OP2: Readonly<Record<string, T>> = {
  ':=': T.Assign,
  '=>': T.Output,
  '..': T.Range,
  '<=': T.Le,
  '>=': T.Ge,
  '<>': T.Ne,
  '**': T.Power,
  '+=': T.PlusAssign,
  '-=': T.MinusAssign,
  '*=': T.TimesAssign,
  '/=': T.DivAssign,
};

const OP1: Readonly<Record<string, T>> = {
  '+': T.Plus,
  '-': T.Minus,
  '*': T.Star,
  '/': T.Slash,
  '<': T.Lt,
  '>': T.Gt,
  '=': T.Eq,
  '(': T.LParen,
  ')': T.RParen,
  '[': T.LBracket,
  ']': T.RBracket,
  '{': T.LBrace,
  '}': T.RBrace,
  ',': T.Comma,
  ';': T.Semicolon,
  ':': T.Colon,
  '.': T.Dot,
  '^': T.Caret,
  '&': T.Ampersand,
  '#': T.Hash,
};

/** Spaces, tabs, no-break spaces and a BOM inside the text. */
const SPACE = new RegExp('[' + String.fromCharCode(0x20, 0x09, 0x0c, 0x0b, 0xa0, 0xfeff) + ']');

const isIdentStart = (c: string) => /[\p{L}_]/u.test(c);
const isIdentPart = (c: string) => /[\p{L}\p{N}_]/u.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

export function lex(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  const push = (kind: T, start: number) => tokens.push({ kind, start, end: i });

  while (i < n) {
    const start = i;
    const c = text[i]!;
    const next = text[i + 1] ?? '';

    if (c === '\r' || c === '\n') {
      i += c === '\r' && next === '\n' ? 2 : 1;
      push(T.Newline, start);
      continue;
    }
    if (SPACE.test(c)) {
      while (i < n && SPACE.test(text[i]!)) i++;
      push(T.Whitespace, start);
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\r' && text[i] !== '\n') i++;
      push(T.LineComment, start);
      continue;
    }
    if ((c === '(' && next === '*') || (c === '/' && next === '*')) {
      const close = c === '(' ? '*)' : '*/';
      const endIndex = text.indexOf(close, i + 2);
      i = endIndex < 0 ? n : endIndex + 2;
      push(T.BlockComment, start);
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"' && text[i] !== '\r' && text[i] !== '\n') i++;
      if (text[i] === '"') i++;
      push(T.Quoted, start);
      continue;
    }
    if (c === "'") {
      i = scanString(text, i);
      push(T.String, start);
      continue;
    }
    if (c === '%' && /[A-Za-z]/.test(next)) {
      i++;
      while (i < n && /[A-Za-z0-9_.]/.test(text[i]!)) {
        // stop before a range operator
        if (text[i] === '.' && text[i + 1] === '.') break;
        i++;
      }
      push(T.Address, start);
      continue;
    }
    if (isDigit(c)) {
      i = scanNumber(text, i);
      push(
        text[i - 1] !== undefined && /#/.test(text.slice(start, i)) ? T.TypedLiteral : T.Number,
        start,
      );
      continue;
    }
    if (isIdentStart(c)) {
      while (i < n && isIdentPart(text[i]!)) i++;
      if (text[i] === '#' && i + 1 < n && !/[\s;,)]/.test(text[i + 1]!)) {
        i = scanTypedLiteralBody(text, i + 1);
        push(T.TypedLiteral, start);
        continue;
      }
      push(T.Identifier, start);
      continue;
    }
    const kind2 = OP2[c + next];
    if (kind2 !== undefined) {
      i = Math.min(i + 2, text.length);
      push(kind2, start);
      continue;
    }
    const kind1 = OP1[c];
    i++;
    push(kind1 ?? T.Unknown, start);
  }
  tokens.push({ kind: T.EOF, start: n, end: n });
  return tokens;
}

/** '...' with $ escapes ($$, $', $L, $N, $P, $R, $T, $hh). Stops at the line end if unclosed. */
function scanString(text: string, i: number): number {
  i++;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '$') {
      i = Math.min(i + 2, text.length);
      continue;
    }
    if (c === "'") return i + 1;
    if (c === '\r' || c === '\n') return i;
    i++;
  }
  return i;
}

/** 123, 1_000, 1.5, 1.0E-3, 16#FF_FF, 2#1010 */
function scanNumber(text: string, i: number): number {
  while (i < text.length && /[0-9_]/.test(text[i]!)) i++;
  if (text[i] === '#') {
    i++;
    while (i < text.length && /[0-9A-Fa-f_]/.test(text[i]!)) i++;
    return i;
  }
  if (text[i] === '.' && isDigit(text[i + 1] ?? '')) {
    i++;
    while (i < text.length && /[0-9_]/.test(text[i]!)) i++;
  }
  if ((text[i] === 'e' || text[i] === 'E') && /[0-9+-]/.test(text[i + 1] ?? '')) {
    const save = i;
    i++;
    if (text[i] === '+' || text[i] === '-') i++;
    if (!isDigit(text[i] ?? '')) return save;
    while (i < text.length && isDigit(text[i]!)) i++;
  }
  return i;
}

/** The part after PREFIX#: a quoted string, or characters of time, date and number literals. */
function scanTypedLiteralBody(text: string, i: number): number {
  if (text[i] === "'") return scanString(text, i);
  while (i < text.length) {
    const c = text[i]!;
    if (c === '.' && text[i + 1] === '.') break;
    if (/[A-Za-z0-9_.:#]/.test(c)) {
      i++;
      continue;
    }
    // a sign is part of the literal only right after '#' or inside dates (2026-01-01)
    if (
      (c === '-' || c === '+') &&
      (/[#]/.test(text[i - 1]!) || /[0-9]/.test(text[i - 1]!)) &&
      /[0-9]/.test(text[i + 1] ?? '')
    ) {
      i++;
      continue;
    }
    break;
  }
  return i;
}
