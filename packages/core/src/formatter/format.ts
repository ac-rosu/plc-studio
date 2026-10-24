// Formatter (spec, "Formatter"): formats only the lines asked for (format-on-save formats the
// changed lines only, VS Code's formatOnSaveMode "modifications"); the whole document only on
// request. It reproduces TIA's own layout, so formatting TIA's files changes nothing:
//   indentation  base + indentSize per nesting level (CASE labels one level in, their statements
//                two); base = NETWORK indentation + 4 in .s7dcl, one TAB in external sources
//   spacing      one space around ':=', '=>', comparisons and binary operators, after commas
//   keywords     upper case (or lower / as written)
//   alignment    optional: ':' and ':=' of consecutive declarations
// Continuation lines of a statement, comments, attribute blocks and LAD/FBD are never touched.
import { DEFAULT_FORMAT, type FormatOptions } from '../analyzer/config.ts';
import { fileKindOf } from '../formats/document.ts';
import type { BlockFile } from '../syntax/ast.ts';
import { lex, T, type Token } from '../syntax/lexer.ts';
import { parseBlockFile } from '../syntax/parser.ts';
import { SourceText } from '../text/source-text.ts';
import type { TextEdit } from '../writer/text-edit.ts';

/** 0-based lines, inclusive. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

const KEYWORDS = new Set([
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
  'AND',
  'OR',
  'XOR',
  'NOT',
  'MOD',
  'TRUE',
  'FALSE',
  'NULL',
]);
const DECLARATION_KEYWORDS = new Set([
  'VAR',
  'VAR_INPUT',
  'VAR_OUTPUT',
  'VAR_IN_OUT',
  'VAR_TEMP',
  'VAR_STAT',
  'END_VAR',
  'CONSTANT',
  'RETAIN',
  'NON_RETAIN',
  'TRUE',
  'FALSE',
]);

const SPACED = new Set<number>([
  T.Assign,
  T.Output,
  T.Eq,
  T.Ne,
  T.Lt,
  T.Gt,
  T.Le,
  T.Ge,
  T.PlusAssign,
  T.MinusAssign,
  T.TimesAssign,
  T.DivAssign,
]);
/** Operators that are binary only with an operand on their left (Array[*], -5, +1). */
const MAYBE_BINARY = new Set<number>([T.Plus, T.Minus, T.Star, T.Slash, T.Power]);
const NO_SPACE_BEFORE = new Set<number>([
  T.Comma,
  T.Semicolon,
  T.RParen,
  T.RBracket,
  T.Dot,
  T.Caret,
  T.LBracket,
  T.Range,
]);
const NO_SPACE_AFTER = new Set<number>([T.LParen, T.LBracket, T.Dot, T.Hash, T.Range]);
const STATEMENT_ENDERS = new Set(['THEN', 'DO', 'OF', 'ELSE', 'REPEAT']);
const CLOSERS = new Set(['END_IF', 'END_CASE', 'END_FOR', 'END_WHILE', 'END_REPEAT', 'END_REGION']);

type LineKind = 'code' | 'declaration' | 'startValue';

interface Frame {
  readonly kind: 'IF' | 'CASE' | 'LOOP' | 'REPEAT' | 'REGION';
}

/** Formats the whole document. */
export function formatDocument(
  path: string,
  text: string,
  options: Partial<FormatOptions> = {},
): TextEdit[] {
  const source = new SourceText(text);
  return formatRanges(path, text, [{ start: 0, end: source.lineCount - 1 }], options);
}

/** Formats only the given lines; every other line stays byte-identical. */
export function formatRanges(
  path: string,
  text: string,
  ranges: readonly LineRange[],
  options: Partial<FormatOptions> = {},
): TextEdit[] {
  const kind = fileKindOf(path);
  if (kind !== 's7dcl' && kind !== 'source') return [];
  const opts: FormatOptions = { ...DEFAULT_FORMAT, ...options };
  const source = new SourceText(text);
  const file = parseBlockFile(source, kind);
  const wanted = new Set<number>();
  for (const r of ranges)
    for (let l = Math.max(0, r.start); l <= Math.min(source.lineCount - 1, r.end); l++)
      wanted.add(l);
  if (wanted.size === 0) return [];
  const kinds = lineKinds(file, source);
  const tokensByLine = groupTokens(file.tokens, source);
  const indents = codeIndentation(file, source, tokensByLine, opts, kind);
  const edits: TextEdit[] = [];
  const newLines = new Map<number, string>();
  for (const line of wanted) {
    const k = kinds.get(line);
    if (!k) continue;
    const old = source.lineText(line);
    if (old.trim() === '') continue;
    let body = respace(old, tokensByLine.get(line) ?? [], source, opts, k);
    const indent = k === 'code' ? indents.get(line) : undefined;
    const leading = /^[ \t]*/.exec(old)![0];
    body = (indent ?? leading) + body.slice(/^[ \t]*/.exec(body)![0].length);
    newLines.set(line, body);
  }
  if (opts.alignAssignments) alignDeclarations(newLines, kinds, wanted);
  for (const [line, text2] of newLines) {
    const old = source.lineText(line);
    if (text2 !== old)
      edits.push({ start: source.lineStart(line), end: source.lineEnd(line), newText: text2 });
  }
  return edits.sort((a, b) => a.start - b.start);
}

function groupTokens(tokens: readonly Token[], source: SourceText): Map<number, Token[]> {
  const out = new Map<number, Token[]>();
  for (const t of tokens) {
    if (t.kind === T.EOF || t.kind === T.Newline) continue;
    const line = source.positionAt(t.start).line;
    const list = out.get(line);
    if (list) list.push(t);
    else out.set(line, [t]);
  }
  return out;
}

/** Which lines the formatter may touch, and how. */
function lineKinds(file: BlockFile, source: SourceText): Map<number, LineKind> {
  const out = new Map<number, LineKind>();
  const mark = (start: number, end: number, kind: LineKind, skipFirst = false) => {
    const a = source.positionAt(start).line + (skipFirst ? 1 : 0);
    const b = source.positionAt(end).line;
    for (let l = a; l <= b; l++) if (!out.has(l)) out.set(l, kind);
  };
  for (const block of file.blocks) {
    for (const s of block.sections) mark(s.range.start, s.range.end, 'declaration');
    if (block.struct) mark(block.struct.range.start, block.struct.range.end, 'declaration', true);
    for (const sv of block.startValues) mark(sv.range.start, sv.range.end, 'startValue');
    for (const n of block.networks) {
      if (n.language !== 'SCL' || !n.statements) continue;
      // the lines strictly between NETWORK/BEGIN and END_NETWORK/END_...
      // bodyRange ends where END_NETWORK / END_FUNCTION... starts: that line is not code
      const first = source.positionAt(n.bodyRange.start).line + 1;
      const last = source.positionAt(n.bodyRange.end).line - 1;
      for (let l = first; l <= last; l++) out.set(l, 'code');
    }
  }
  // code with syntax errors: its structure is unknown, so it is left as it is
  for (const block of file.blocks) {
    for (const n of block.networks) {
      const broken = file.diagnostics.some(
        (d) =>
          d.severity === 'error' && d.range.start >= n.range.start && d.range.start <= n.range.end,
      );
      if (!broken) continue;
      for (
        let l = source.positionAt(n.range.start).line;
        l <= source.positionAt(n.range.end).line;
        l++
      )
        out.delete(l);
    }
  }
  // never touch lines inside multi-line block comments or not-analyzed text
  for (const t of file.tokens) {
    if (
      t.kind === T.BlockComment &&
      source.positionAt(t.start).line !== source.positionAt(t.end).line
    ) {
      for (let l = source.positionAt(t.start).line; l <= source.positionAt(t.end).line; l++)
        out.delete(l);
    }
  }
  for (const r of file.notAnalyzed)
    for (let l = source.positionAt(r.start).line; l <= source.positionAt(r.end).line; l++)
      out.delete(l);
  return out;
}

const word = (t: Token, source: SourceText) =>
  t.kind === T.Identifier ? source.text.slice(t.start, t.end).toUpperCase() : '';

/** Indentation of every statement-start line of SCL code; continuation lines get none. */
function codeIndentation(
  file: BlockFile,
  source: SourceText,
  tokensByLine: Map<number, Token[]>,
  opts: FormatOptions,
  kind: 's7dcl' | 'source',
): Map<number, string> {
  const out = new Map<number, string>();
  const unit = ' '.repeat(opts.indentSize);
  for (const block of file.blocks) {
    for (const n of block.networks) {
      if (n.language !== 'SCL' || !n.statements) continue;
      const keywordLine = source.positionAt(n.keywordRange.start).line;
      const base =
        kind === 's7dcl' ? /^[ \t]*/.exec(source.lineText(keywordLine))![0] + '    ' : '\t';
      const frames: (Frame & { inClause?: boolean })[] = [];
      let paren = 0;
      let statementStart = true;
      const depthOf = (count: number) => {
        let d = 1;
        for (let i = 0; i < count; i++)
          d += frames[i]!.kind === 'CASE' ? (frames[i]!.inClause ? 2 : 1) : 1;
        return d;
      };
      const first = source.positionAt(n.bodyRange.start).line + 1;
      const last = source.positionAt(n.bodyRange.end).line - 1;
      for (let line = first; line <= last; line++) {
        const tokens = (tokensByLine.get(line) ?? []).filter((t) => t.kind !== T.Whitespace);
        const significant = tokens.filter(
          (t) => t.kind !== T.LineComment && t.kind !== T.BlockComment,
        );
        if (tokens.length === 0) continue;
        const w = significant.length > 0 ? word(significant[0]!, source) : '';
        if (paren === 0 && statementStart) {
          let depth = depthOf(frames.length);
          const top = frames[frames.length - 1];
          if (CLOSERS.has(w)) {
            depth = depthOf(Math.max(0, frames.length - 1));
            if (top?.kind === 'CASE') depth = depthOf(frames.length - 1);
          } else if ((w === 'ELSE' || w === 'ELSIF') && top?.kind === 'IF')
            depth = depthOf(frames.length - 1);
          else if (w === 'UNTIL' && top?.kind === 'REPEAT') depth = depthOf(frames.length - 1);
          else if (top?.kind === 'CASE' && (w === 'ELSE' || isCaseLabel(significant, source))) {
            depth = depthOf(frames.length - 1) + 1;
          }
          out.set(line, base + unit.repeat(depth));
        }
        // update state with the line's tokens
        let regionTitle = false;
        for (const t of significant) {
          if (regionTitle) break;
          if (t.kind === T.LParen || t.kind === T.LBracket) paren++;
          if ((t.kind === T.RParen || t.kind === T.RBracket) && paren > 0) paren--;
          const kw = word(t, source);
          switch (kw) {
            case 'IF':
              frames.push({ kind: 'IF' });
              break;
            case 'CASE':
              frames.push({ kind: 'CASE' });
              break;
            case 'FOR':
            case 'WHILE':
              frames.push({ kind: 'LOOP' });
              break;
            case 'REPEAT':
              frames.push({ kind: 'REPEAT' });
              break;
            case 'REGION':
              frames.push({ kind: 'REGION' });
              regionTitle = true;
              break;
            case 'END_IF':
            case 'END_CASE':
            case 'END_FOR':
            case 'END_WHILE':
            case 'END_REPEAT':
            case 'END_REGION':
              frames.pop();
              break;
            default:
              break;
          }
        }
        const top = frames[frames.length - 1];
        if (
          top?.kind === 'CASE' &&
          paren === 0 &&
          (isCaseLabel(significant, source) || w === 'ELSE')
        )
          top.inClause = true;
        const lastToken = significant[significant.length - 1];
        const lw = lastToken ? word(lastToken, source) : '';
        statementStart =
          significant.length === 0 ||
          regionTitle ||
          lastToken?.kind === T.Semicolon ||
          lastToken?.kind === T.Colon ||
          STATEMENT_ENDERS.has(lw) ||
          CLOSERS.has(lw) ||
          (w === 'UNTIL' && paren === 0);
      }
    }
  }
  return out;
}

/** `1:`, `2..5:`, `#STATE_IDLE:`, `Int:` at the start of a line inside CASE. */
function isCaseLabel(tokens: readonly Token[], source: SourceText): boolean {
  for (const t of tokens) {
    if (t.kind === T.Colon) return true;
    if (t.kind === T.Assign || t.kind === T.Semicolon || t.kind === T.LParen) return false;
    if (
      t.kind === T.Identifier &&
      KEYWORDS.has(word(t, source)) &&
      !['TRUE', 'FALSE'].includes(word(t, source))
    )
      return false;
  }
  return false;
}

/** Spacing and keyword casing of one line; comments and attribute braces keep their text. */
function respace(
  old: string,
  lineTokens: readonly Token[],
  source: SourceText,
  opts: FormatOptions,
  kind: LineKind,
): string {
  const tokens = lineTokens.filter((t) => t.kind !== T.Whitespace);
  if (tokens.length === 0) return old;
  const lineStart = source.positionAt(tokens[0]!.start).line;
  const offset = source.lineStart(lineStart);
  let out = old.slice(0, tokens[0]!.start - offset);
  let braces = 0;
  let regionTitle = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const prev = tokens[i - 1];
    let text = source.text.slice(t.start, t.end);
    if (prev) {
      const original = source.text.slice(prev.end, t.start);
      out +=
        regionTitle ||
        braces > 0 ||
        t.kind === T.LineComment ||
        t.kind === T.BlockComment ||
        prev.kind === T.BlockComment
          ? original
          : gap(prev, t, original, tokens[i - 2], source, opts, kind);
    }
    if (t.kind === T.LBrace) braces++;
    if (t.kind === T.RBrace && braces > 0) braces--;
    if (
      !regionTitle &&
      braces === 0 &&
      t.kind === T.Identifier &&
      opts.keywordCase !== 'preserve' &&
      prev?.kind !== T.Hash &&
      prev?.kind !== T.Dot
    ) {
      const upper = text.toUpperCase();
      const isKeyword =
        kind === 'declaration' ? DECLARATION_KEYWORDS.has(upper) : KEYWORDS.has(upper);
      if (isKeyword) text = opts.keywordCase === 'upper' ? upper : text.toLowerCase();
    }
    out += text;
    if (t.kind === T.Identifier && text.toUpperCase() === 'REGION' && i === 0) regionTitle = true;
  }
  return out + old.slice(tokens[tokens.length - 1]!.end - offset);
}

// A keyword such as BY, TO or THEN ends no operand: the sign after it is unary.
const OPERAND_KEYWORDS = new Set(['TRUE', 'FALSE', 'NULL']);

const isOperand = (t: Token | undefined, source: SourceText) =>
  t !== undefined &&
  ((t.kind === T.Identifier &&
    (!KEYWORDS.has(word(t, source)) || OPERAND_KEYWORDS.has(word(t, source)))) ||
    t.kind === T.Quoted ||
    t.kind === T.Number ||
    t.kind === T.TypedLiteral ||
    t.kind === T.String ||
    t.kind === T.RParen ||
    t.kind === T.RBracket ||
    t.kind === T.Address ||
    t.kind === T.Caret);

function gap(
  prev: Token,
  t: Token,
  original: string,
  before: Token | undefined,
  source: SourceText,
  opts: FormatOptions,
  kind: LineKind,
): string {
  if (!opts.spaceAroundOperators) return original;
  if (original.includes('\n') || original.includes('\r')) return original;
  // unary minus/plus: no space between sign and operand
  const prevIsUnary = (prev.kind === T.Minus || prev.kind === T.Plus) && !isOperand(before, source);
  if (prevIsUnary) return '';
  const binarySign = (x: Token, left: Token | undefined) =>
    MAYBE_BINARY.has(x.kind) && isOperand(left, source);
  if (SPACED.has(t.kind) || binarySign(t, prev)) return ' ';
  if (SPACED.has(prev.kind) || binarySign(prev, before)) return ' ';
  if (kind === 'declaration' && (t.kind === T.Colon || prev.kind === T.Colon)) return ' ';
  if (t.kind === T.Colon) return original === '' ? '' : original;
  // "[" opens an index (a[1]), except after ARRAY or a comma, where it opens an array value
  const openingValue =
    t.kind === T.LBracket && (word(prev, source) === 'ARRAY' || prev.kind === T.Comma);
  if (NO_SPACE_BEFORE.has(t.kind) && !openingValue) {
    // a call's "(" right after its name: keep TIA's "Name(" and "Name ("
    return '';
  }
  if (NO_SPACE_AFTER.has(prev.kind)) return '';
  if (prev.kind === T.Comma) return ' ';
  return original;
}

/** Aligns ':' and ':=' of consecutive declaration lines that are all being formatted. */
function alignDeclarations(
  lines: Map<number, string>,
  kinds: Map<number, LineKind>,
  wanted: Set<number>,
): void {
  const sorted = [...lines.keys()]
    .filter((l) => kinds.get(l) === 'declaration' && wanted.has(l))
    .sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const l of sorted) {
    const text = lines.get(l)!;
    if (!/^\s*[A-Za-z_"][^:]*\s:\s/.test(text) || /^\s*\{/.test(text)) {
      groups.push([]);
      continue;
    }
    const g = groups[groups.length - 1];
    if (g && g.length > 0 && g[g.length - 1] === l - 1) g.push(l);
    else groups.push([l]);
  }
  for (const g of groups) {
    if (g.length < 2) continue;
    const parts = g.map((l) => {
      const m = /^(\s*)(.*?)\s:\s(.*?)(?:\s:=\s(.*))?$/.exec(lines.get(l)!)!;
      return { l, indent: m[1]!, name: m[2]!, type: m[3]!, value: m[4] };
    });
    const nameWidth = Math.max(...parts.map((p) => p.name.length));
    const typeWidth = Math.max(
      ...parts.filter((p) => p.value !== undefined).map((p) => p.type.length),
      0,
    );
    for (const p of parts) {
      const head = `${p.indent}${p.name.padEnd(nameWidth)} : `;
      lines.set(
        p.l,
        p.value === undefined ? head + p.type : `${head}${p.type.padEnd(typeWidth)} := ${p.value}`,
      );
    }
  }
}

export { lex };
