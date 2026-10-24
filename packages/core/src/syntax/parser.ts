// Recursive-descent parser for SIMATIC SD documents (.s7dcl) and external sources (.scl, .udt,
// .db). Malformed known constructs are syntax errors; constructs the parser does not know are
// kept as they are and marked "not analyzed" (spec, principle 4).
import type { Range } from '../text/source-text.ts';
import { SourceText } from '../text/source-text.ts';
import type {
  Argument,
  ArrayDimension,
  AssignOperator,
  Attribute,
  AttributeBlock,
  BinaryOperator,
  Block,
  BlockFile,
  BlockFileFormat,
  BlockKind,
  CallExpression,
  CaseClause,
  CaseLabel,
  ConditionalBranch,
  Expression,
  LadderBody,
  LadderElement,
  LadderLabel,
  Member,
  Name,
  NamedType,
  Network,
  NetworkLanguage,
  Rung,
  RungItem,
  RungStart,
  SectionKind,
  Statement,
  StructType,
  SyntaxDiagnostic,
  TypeNode,
  VarSection,
  Assignment,
} from './ast.ts';
import { isTrivia, lex, T, type Token } from './lexer.ts';

const BLOCK_KEYWORDS: Readonly<Record<string, BlockKind>> = {
  ORGANIZATION_BLOCK: 'OB',
  FUNCTION_BLOCK: 'FB',
  FUNCTION: 'FC',
  DATA_BLOCK: 'DB',
  TYPE: 'UDT',
};

const BLOCK_END: Readonly<Record<BlockKind, string>> = {
  OB: 'END_ORGANIZATION_BLOCK',
  FB: 'END_FUNCTION_BLOCK',
  FC: 'END_FUNCTION',
  DB: 'END_DATA_BLOCK',
  UDT: 'END_TYPE',
};

const SECTION_KEYWORDS: Readonly<Record<string, SectionKind>> = {
  VAR_INPUT: 'Input',
  VAR_OUTPUT: 'Output',
  VAR_IN_OUT: 'InOut',
  VAR: 'Static',
  VAR_STAT: 'Static',
  VAR_TEMP: 'Temp',
};

const SECTION_MODIFIERS = new Set(['RETAIN', 'NON_RETAIN', 'CONSTANT', 'DB_SPECIFIC']);

/** Words that end a statement list. */
const CLOSERS = new Set([
  'END_IF',
  'ELSIF',
  'ELSE',
  'END_CASE',
  'END_FOR',
  'END_WHILE',
  'END_REPEAT',
  'UNTIL',
  'END_REGION',
  'END_NETWORK',
  'END_FUNCTION',
  'END_FUNCTION_BLOCK',
  'END_ORGANIZATION_BLOCK',
  'END_DATA_BLOCK',
  'END_TYPE',
  'END_NAMESPACE',
  'BEGIN',
]);

const STATEMENT_KEYWORDS = new Set([
  'IF',
  'CASE',
  'FOR',
  'WHILE',
  'REPEAT',
  'EXIT',
  'CONTINUE',
  'RETURN',
  'GOTO',
  'REGION',
]);

const ASSIGN_OPS: Partial<Record<T, AssignOperator>> = {
  [T.Assign]: ':=',
  [T.PlusAssign]: '+=',
  [T.MinusAssign]: '-=',
  [T.TimesAssign]: '*=',
  [T.DivAssign]: '/=',
};

export class Parser {
  readonly tokens: Token[];
  readonly diagnostics: SyntaxDiagnostic[] = [];
  readonly notAnalyzed: Range[] = [];
  private pos = 0;
  private lastIndex = -1;
  private last: Token = { kind: T.EOF, start: 0, end: 0 };
  private caseDepth = 0;

  readonly source: SourceText;

  constructor(source: SourceText) {
    this.source = source;
    this.tokens = lex(source.text);
  }

  // --- Cursor ------------------------------------------------------------------------------

  tok(): Token {
    while (isTrivia(this.tokens[this.pos]!.kind)) this.pos++;
    return this.tokens[this.pos]!;
  }

  /** The n-th significant token after the current one (n = 1: the next one). */
  peek(n = 1): Token {
    this.tok();
    let i = this.pos;
    let count = 0;
    for (;;) {
      const t = this.tokens[i]!;
      if (t.kind === T.EOF) return t;
      if (!isTrivia(t.kind)) {
        if (count === n) return t;
        count++;
      }
      i++;
    }
  }

  next(): Token {
    const t = this.tok();
    this.lastIndex = this.pos;
    if (t.kind !== T.EOF) this.pos++;
    this.last = t;
    return t;
  }

  text(t: Token): string {
    return this.source.text.slice(t.start, t.end);
  }

  word(t: Token = this.tok()): string {
    return t.kind === T.Identifier ? this.text(t).toUpperCase() : '';
  }

  at(kind: T): boolean {
    return this.tok().kind === kind;
  }

  atWord(...words: string[]): boolean {
    const w = this.word();
    return w !== '' && words.includes(w);
  }

  eat(kind: T): Token | undefined {
    return this.at(kind) ? this.next() : undefined;
  }

  eatWord(word: string): Token | undefined {
    return this.atWord(word) ? this.next() : undefined;
  }

  get lastEnd(): number {
    return this.last.end;
  }

  /** True when a line break separates the last consumed token from the current one. */
  newlineBefore(): boolean {
    this.tok();
    for (let i = this.lastIndex + 1; i < this.pos; i++) {
      if (this.tokens[i]!.kind === T.Newline) return true;
    }
    return false;
  }

  /** Consumes the rest of the current line as raw text (TITLE, REGION names). */
  restOfLine(): { text: string; range: Range } {
    let i = this.pos;
    // skip leading whitespace only
    while (this.tokens[i]!.kind === T.Whitespace) i++;
    const start = this.tokens[i]!.start;
    let end = start;
    while (this.tokens[i]!.kind !== T.Newline && this.tokens[i]!.kind !== T.EOF) {
      if (this.tokens[i]!.kind !== T.Whitespace) end = this.tokens[i]!.end;
      i++;
    }
    this.pos = i;
    this.lastIndex = i - 1;
    if (end > start) this.last = { kind: T.Identifier, start, end };
    return { text: this.source.text.slice(start, end), range: { start, end } };
  }

  error(range: Range, message: string, code = 'syntax'): void {
    this.diagnostics.push({ range, message, severity: 'error', code });
  }

  markNotAnalyzed(range: Range, what: string): void {
    if (range.end <= range.start) return;
    this.notAnalyzed.push(range);
    this.diagnostics.push({
      range,
      message: `Not analyzed: ${what}. The text is kept as it is.`,
      severity: 'info',
      code: 'not-analyzed',
    });
  }

  /** Range of the last consumed token: where a missing terminator is reported. */
  private lastRange(): Range {
    return { start: this.last.start, end: this.last.end };
  }

  private here(): Range {
    const t = this.tok();
    return t.kind === T.EOF ? this.lastRange() : { start: t.start, end: t.end };
  }

  private expect(kind: T, what: string): Token | undefined {
    if (this.at(kind)) return this.next();
    this.error(this.lastRange(), `Expected ${what}.`);
    return undefined;
  }

  private expectWord(word: string): Token | undefined {
    if (this.atWord(word)) return this.next();
    this.error(this.lastRange(), `Expected ${word}.`);
    return undefined;
  }

  // --- Names and attributes ------------------------------------------------------------------

  private nameFrom(t: Token): Name {
    const raw = this.text(t);
    const quoted = t.kind === T.Quoted;
    return {
      text: quoted ? raw.slice(1, raw.endsWith('"') && raw.length > 1 ? -1 : undefined) : raw,
      quoted,
      range: { start: t.start, end: t.end },
    };
  }

  /** Identifier or "quoted" name. */
  private parseName(what: string): Name | undefined {
    if (this.at(T.Identifier) || this.at(T.Quoted)) return this.nameFrom(this.next());
    this.error(this.here(), `Expected ${what}.`);
    return undefined;
  }

  parseAttributeBlock(): AttributeBlock {
    const open = this.next(); // {
    const attributes: Attribute[] = [];
    while (!this.at(T.RBrace) && !this.at(T.EOF)) {
      if (!this.at(T.Identifier)) {
        // something we do not understand inside an attribute block: keep it
        const start = this.tok().start;
        while (!this.at(T.RBrace) && !this.at(T.EOF) && !this.at(T.Semicolon)) this.next();
        this.markNotAnalyzed({ start, end: this.lastEnd }, 'attribute');
        this.eat(T.Semicolon);
        continue;
      }
      const nameTok = this.next();
      if (!this.eat(T.Assign)) {
        this.error(this.lastRange(), "Expected ':=' in the attribute.");
        while (!this.at(T.RBrace) && !this.at(T.EOF) && !this.at(T.Semicolon)) this.next();
        this.eat(T.Semicolon);
        continue;
      }
      const valueTok = this.next();
      const raw = this.text(valueTok);
      const value =
        valueTok.kind === T.Quoted || valueTok.kind === T.String ? raw.slice(1, -1) : raw;
      attributes.push({
        name: this.text(nameTok),
        value,
        nameRange: { start: nameTok.start, end: nameTok.end },
        valueRange: { start: valueTok.start, end: valueTok.end },
        range: { start: nameTok.start, end: valueTok.end },
      });
      this.eat(T.Semicolon);
    }
    this.expect(T.RBrace, "'}'");
    return { attributes, range: { start: open.start, end: this.lastEnd } };
  }

  // --- Expressions -----------------------------------------------------------------------------

  parseExpression(): Expression {
    return this.parseBinary(0);
  }

  private static readonly LEVELS: ReadonlyArray<ReadonlyArray<[T | string, BinaryOperator]>> = [
    [['OR', 'OR']],
    [['XOR', 'XOR']],
    [
      ['AND', 'AND'],
      [T.Ampersand, 'AND'],
    ],
    [
      [T.Eq, '='],
      [T.Ne, '<>'],
    ],
    [
      [T.Lt, '<'],
      [T.Gt, '>'],
      [T.Le, '<='],
      [T.Ge, '>='],
    ],
    [
      [T.Plus, '+'],
      [T.Minus, '-'],
    ],
    [
      [T.Star, '*'],
      [T.Slash, '/'],
      ['MOD', 'MOD'],
    ],
    [[T.Power, '**']],
  ];

  private matchOperator(level: number): BinaryOperator | undefined {
    for (const [token, op] of Parser.LEVELS[level]!) {
      if (typeof token === 'string' ? this.atWord(token) : this.at(token)) return op;
    }
    return undefined;
  }

  private parseBinary(level: number): Expression {
    if (level >= Parser.LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (let op = this.matchOperator(level); op; op = this.matchOperator(level)) {
      this.next();
      const right = this.parseBinary(level + 1);
      left = {
        kind: 'binary',
        op,
        left,
        right,
        range: { start: left.range.start, end: right.range.end },
      };
    }
    return left;
  }

  private parseUnary(): Expression {
    const t = this.tok();
    if (this.atWord('NOT') || this.at(T.Minus) || this.at(T.Plus)) {
      this.next();
      const op = t.kind === T.Minus ? '-' : t.kind === T.Plus ? '+' : 'NOT';
      const operand = this.parseUnary();
      return { kind: 'unary', op, operand, range: { start: t.start, end: operand.range.end } };
    }
    return this.parsePostfix(true);
  }

  /** Primary with member access, indexing, dereference and (optionally) calls. */
  parsePostfix(allowCall: boolean): Expression {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.at(T.Dot) && !this.at(T.Range)) {
        const dot = this.next();
        const t = this.tok();
        if (
          t.kind === T.Identifier ||
          t.kind === T.Quoted ||
          t.kind === T.Address ||
          t.kind === T.Number
        ) {
          this.next();
          const raw = this.text(t);
          const member: Name =
            t.kind === T.Quoted
              ? this.nameFrom(t)
              : { text: raw, quoted: false, range: { start: t.start, end: t.end } };
          expr = {
            kind: 'member',
            object: expr,
            member,
            range: { start: expr.range.start, end: t.end },
          };
        } else {
          this.error({ start: dot.start, end: dot.end }, "Expected a member name after '.'.");
          break;
        }
      } else if (this.at(T.LBracket)) {
        this.next();
        const indexes: Expression[] = [this.parseExpression()];
        while (this.eat(T.Comma)) indexes.push(this.parseExpression());
        this.expect(T.RBracket, "']'");
        expr = {
          kind: 'index',
          object: expr,
          indexes,
          range: { start: expr.range.start, end: this.lastEnd },
        };
      } else if (this.at(T.Caret)) {
        this.next();
        expr = {
          kind: 'deref',
          object: expr,
          range: { start: expr.range.start, end: this.lastEnd },
        };
      } else if (allowCall && this.at(T.LParen)) {
        expr = this.parseCallArgs(expr);
      } else {
        break;
      }
    }
    return expr;
  }

  parseCallArgs(callee: Expression): CallExpression {
    const open = this.next(); // (
    const args: Argument[] = [];
    if (!this.at(T.RParen)) {
      for (;;) {
        args.push(this.parseArgument());
        if (!this.eat(T.Comma)) break;
      }
    }
    this.expect(T.RParen, "')'");
    return {
      kind: 'call',
      callee,
      args,
      argsRange: { start: open.start, end: this.lastEnd },
      range: { start: callee.range.start, end: this.lastEnd },
    };
  }

  private parseArgument(): Argument {
    const t = this.tok();
    const after = this.peek(1);
    if (
      (t.kind === T.Identifier || t.kind === T.Quoted) &&
      (after.kind === T.Assign || after.kind === T.Output)
    ) {
      const name = this.nameFrom(this.next());
      const direction = this.next().kind === T.Output ? 'out' : 'in';
      const value = this.parseExpression();
      return { name, direction, value, range: { start: t.start, end: value.range.end } };
    }
    const value = this.parseExpression();
    return { name: undefined, direction: 'positional', value, range: value.range };
  }

  private parsePrimary(): Expression {
    const t = this.tok();
    const range = { start: t.start, end: t.end };
    switch (t.kind) {
      case T.Number: {
        this.next();
        const raw = this.text(t);
        const real = /[.eE]/.test(raw) && !raw.includes('#');
        return {
          kind: 'literal',
          literalKind: real ? 'real' : 'int',
          text: raw,
          prefix: undefined,
          range,
        };
      }
      case T.TypedLiteral: {
        this.next();
        const raw = this.text(t);
        const prefix = raw.slice(0, raw.indexOf('#')).toUpperCase();
        const isBase = /^\d+$/.test(prefix);
        return { kind: 'literal', literalKind: isBase ? 'int' : 'typed', text: raw, prefix, range };
      }
      case T.String:
        this.next();
        return {
          kind: 'literal',
          literalKind: 'string',
          text: this.text(t),
          prefix: undefined,
          range,
        };
      case T.Quoted:
        this.next();
        return { kind: 'global', name: this.nameFrom(t), range };
      case T.Address:
        this.next();
        return { kind: 'address', text: this.text(t), range };
      case T.Hash: {
        this.next();
        const n = this.tok();
        if (n.kind === T.Identifier || n.kind === T.Quoted) {
          this.next();
          return { kind: 'local', name: this.nameFrom(n), range: { start: t.start, end: n.end } };
        }
        this.error(range, "Expected a name after '#'.");
        return { kind: 'error', range };
      }
      case T.LParen: {
        this.next();
        // () and (a, b, ...): start values of a structured member; (a) is an expression in parentheses
        if (this.eat(T.RParen))
          return { kind: 'structLiteral', items: [], range: { start: t.start, end: this.lastEnd } };
        const inner = this.parseExpression();
        if (this.at(T.Comma)) {
          const items = [inner];
          while (this.eat(T.Comma)) items.push(this.parseExpression());
          this.expect(T.RParen, "')'");
          return { kind: 'structLiteral', items, range: { start: t.start, end: this.lastEnd } };
        }
        this.expect(T.RParen, "')'");
        return { kind: 'paren', inner, range: { start: t.start, end: this.lastEnd } };
      }
      case T.LBracket: {
        this.next();
        const items: Expression[] = [];
        if (!this.at(T.RBracket)) {
          do items.push(this.parseExpression());
          while (this.eat(T.Comma));
        }
        this.expect(T.RBracket, "']'");
        return { kind: 'arrayLiteral', items, range: { start: t.start, end: this.lastEnd } };
      }
      case T.Identifier: {
        const w = this.word();
        if (w === 'TRUE' || w === 'FALSE') {
          this.next();
          return {
            kind: 'literal',
            literalKind: 'bool',
            text: this.text(t),
            prefix: undefined,
            range,
          };
        }
        if (w === 'NULL') {
          this.next();
          return {
            kind: 'literal',
            literalKind: 'null',
            text: this.text(t),
            prefix: undefined,
            range,
          };
        }
        if (
          CLOSERS.has(w) ||
          STATEMENT_KEYWORDS.has(w) ||
          w === 'THEN' ||
          w === 'DO' ||
          w === 'OF' ||
          w === 'TO' ||
          w === 'BY'
        ) {
          this.error(this.lastRange(), 'Expected an expression.');
          return { kind: 'error', range: { start: this.lastEnd, end: this.lastEnd } };
        }
        this.next();
        return { kind: 'name', name: this.nameFrom(t), range };
      }
      default:
        this.error(t.kind === T.EOF ? this.lastRange() : range, 'Expected an expression.');
        if (
          t.kind !== T.EOF &&
          t.kind !== T.Semicolon &&
          t.kind !== T.RParen &&
          t.kind !== T.RBracket
        )
          this.next();
        return { kind: 'error', range };
    }
  }

  // --- Statements ------------------------------------------------------------------------------

  /** Statements until a closing keyword (END_IF, ELSE ...) or, inside CASE, the next label. */
  parseStatements(): Statement[] {
    const statements: Statement[] = [];
    for (;;) {
      const t = this.tok();
      if (t.kind === T.EOF) break;
      if (CLOSERS.has(this.word())) break;
      if (this.caseDepth > 0 && this.looksLikeCaseLabel()) break;
      const before = this.pos;
      statements.push(this.parseStatement());
      if (this.pos === before) {
        // no progress: keep the token and move on
        const bad = this.next();
        this.markNotAnalyzed({ start: bad.start, end: bad.end }, 'unexpected text');
      }
    }
    return statements;
  }

  /** CASE labels: constants, ranges and type names separated by commas, then ':' (not ':='). */
  private looksLikeCaseLabel(): boolean {
    let i = 0;
    for (;;) {
      const t = this.peek(i);
      switch (t.kind) {
        case T.Colon:
          return i > 0;
        case T.Number:
        case T.TypedLiteral:
        case T.Identifier:
        case T.Quoted:
        case T.Hash:
        case T.Minus:
        case T.Plus:
        case T.Range:
        case T.Comma:
        case T.Dot:
        case T.String:
          if (t.kind === T.Identifier && STATEMENT_KEYWORDS.has(this.word(t))) return false;
          i++;
          if (i > 64) return false;
          continue;
        default:
          return false;
      }
    }
  }

  private terminate(): void {
    if (this.eat(T.Semicolon)) return;
    this.error(this.lastRange(), "Missing ';' at the end of the statement.", 'missing-semicolon');
  }

  /** ';' after END_IF, END_CASE ... is written by TIA; accepted when missing. */
  private optionalSemicolon(): void {
    this.eat(T.Semicolon);
  }

  parseStatement(): Statement {
    const t = this.tok();
    const start = t.start;
    const w = this.word();
    switch (w) {
      case 'IF':
        return this.parseIf();
      case 'CASE':
        return this.parseCase();
      case 'FOR':
        return this.parseFor();
      case 'WHILE':
        return this.parseWhile();
      case 'REPEAT':
        return this.parseRepeat();
      case 'REGION':
        return this.parseRegion();
      case 'EXIT':
      case 'CONTINUE':
      case 'RETURN': {
        this.next();
        this.terminate();
        const kind = w === 'EXIT' ? 'exit' : w === 'CONTINUE' ? 'continue' : 'return';
        return { kind, range: { start, end: this.lastEnd } };
      }
      case 'GOTO': {
        this.next();
        const label = this.parseName('a jump label') ?? {
          text: '',
          quoted: false,
          range: this.here(),
        };
        this.terminate();
        return { kind: 'goto', label, range: { start, end: this.lastEnd } };
      }
    }
    if (t.kind === T.Semicolon) {
      this.next();
      return { kind: 'empty', range: { start, end: this.lastEnd } };
    }
    if (t.kind === T.Identifier && this.peek(1).kind === T.Colon) {
      const label = this.nameFrom(this.next());
      this.next();
      return { kind: 'label', label, range: { start, end: this.lastEnd } };
    }
    if (
      t.kind === T.Hash ||
      t.kind === T.Quoted ||
      t.kind === T.Identifier ||
      t.kind === T.Address ||
      t.kind === T.LParen
    ) {
      const target = this.parsePostfix(true);
      const op = ASSIGN_OPS[this.tok().kind];
      if (op) {
        this.next();
        const value = this.parseExpression();
        this.terminate();
        return { kind: 'assign', target, op, value, range: { start, end: this.lastEnd } };
      }
      if (target.kind === 'call') {
        this.terminate();
        return { kind: 'callStatement', call: target, range: { start, end: this.lastEnd } };
      }
      this.error(this.lastRange(), "Expected ':=' or a call.");
      this.skipToStatementEnd();
      return { kind: 'notAnalyzed', range: { start, end: this.lastEnd } };
    }
    // Unknown construct: keep it, mark it, continue after its ';' or line.
    this.skipToStatementEnd();
    this.markNotAnalyzed({ start, end: this.lastEnd }, 'statement');
    return { kind: 'notAnalyzed', range: { start, end: this.lastEnd } };
  }

  private skipToStatementEnd(): void {
    let depth = 0;
    for (;;) {
      const t = this.tok();
      if (t.kind === T.EOF) return;
      if (depth === 0 && CLOSERS.has(this.word())) return;
      if (t.kind === T.LParen || t.kind === T.LBracket) depth++;
      if ((t.kind === T.RParen || t.kind === T.RBracket) && depth > 0) depth--;
      this.next();
      if (t.kind === T.Semicolon && depth === 0) return;
    }
  }

  private closeWith(word: string, opener: Token): void {
    if (this.eatWord(word)) {
      this.optionalSemicolon();
      return;
    }
    this.error(
      this.lastRange(),
      `Missing ${word} for the ${this.text(opener).toUpperCase()} in line ${this.source.positionAt(opener.start).line + 1}.`,
    );
  }

  private parseIf(): Statement {
    const opener = this.next();
    const branches: ConditionalBranch[] = [];
    let branchStart = opener.start;
    for (;;) {
      const condition = this.parseExpression();
      this.expectWord('THEN');
      const body = this.parseStatements();
      branches.push({ condition, body, range: { start: branchStart, end: this.lastEnd } });
      if (this.atWord('ELSIF')) {
        branchStart = this.next().start;
        continue;
      }
      break;
    }
    let elseBody: Statement[] | undefined;
    if (this.eatWord('ELSE')) elseBody = this.parseStatements();
    this.closeWith('END_IF', opener);
    return { kind: 'if', branches, elseBody, range: { start: opener.start, end: this.lastEnd } };
  }

  private parseCase(): Statement {
    const opener = this.next();
    const selector = this.parseExpression();
    this.expectWord('OF');
    const clauses: CaseClause[] = [];
    let elseBody: Statement[] | undefined;
    // While inside CASE, statement lists stop at the next label (looksLikeCaseLabel).
    this.caseDepth++;
    try {
      for (;;) {
        if (this.atWord('ELSE')) {
          this.next();
          this.eat(T.Colon);
          elseBody = this.parseStatements();
          break;
        }
        if (this.at(T.EOF) || CLOSERS.has(this.word())) break;
        const clauseStart = this.tok().start;
        const labels: CaseLabel[] = [];
        do {
          const from = this.parseExpression();
          let to: Expression | undefined;
          if (this.eat(T.Range)) to = this.parseExpression();
          labels.push({ from, to, range: { start: from.range.start, end: this.lastEnd } });
        } while (this.eat(T.Comma));
        this.expect(T.Colon, "':' after the CASE label");
        const body = this.parseStatements();
        clauses.push({ labels, body, range: { start: clauseStart, end: this.lastEnd } });
      }
    } finally {
      this.caseDepth--;
    }
    this.closeWith('END_CASE', opener);
    return {
      kind: 'case',
      selector,
      clauses,
      elseBody,
      range: { start: opener.start, end: this.lastEnd },
    };
  }

  private parseFor(): Statement {
    const opener = this.next();
    const variable = this.parsePostfix(false);
    this.expect(T.Assign, "':=' in the FOR statement");
    const from = this.parseExpression();
    this.expectWord('TO');
    const to = this.parseExpression();
    let by: Expression | undefined;
    if (this.eatWord('BY')) by = this.parseExpression();
    this.expectWord('DO');
    const body = this.parseStatements();
    this.closeWith('END_FOR', opener);
    return {
      kind: 'for',
      variable,
      from,
      to,
      by,
      body,
      range: { start: opener.start, end: this.lastEnd },
    };
  }

  private parseWhile(): Statement {
    const opener = this.next();
    const condition = this.parseExpression();
    this.expectWord('DO');
    const body = this.parseStatements();
    this.closeWith('END_WHILE', opener);
    return { kind: 'while', condition, body, range: { start: opener.start, end: this.lastEnd } };
  }

  private parseRepeat(): Statement {
    const opener = this.next();
    const body = this.parseStatements();
    let condition: Expression = { kind: 'error', range: this.lastRange() };
    if (this.eatWord('UNTIL')) {
      condition = this.parseExpression();
      this.eat(T.Semicolon);
    } else {
      this.error(this.lastRange(), 'Missing UNTIL in the REPEAT statement.');
    }
    this.closeWith('END_REPEAT', opener);
    return { kind: 'repeat', body, condition, range: { start: opener.start, end: this.lastEnd } };
  }

  private parseRegion(): Statement {
    const opener = this.next();
    const title = this.restOfLine();
    const body = this.parseStatements();
    this.closeWith('END_REGION', opener);
    return {
      kind: 'region',
      title: title.text,
      titleRange: title.range,
      body,
      range: { start: opener.start, end: this.lastEnd },
    };
  }

  // --- Types ---------------------------------------------------------------------------------

  parseType(): TypeNode {
    const t = this.tok();
    const start = t.start;
    const w = this.word();
    if (w === 'ARRAY') {
      this.next();
      const dimensions: ArrayDimension[] = [];
      this.expect(T.LBracket, "'[' after Array");
      do {
        const ds = this.tok().start;
        if (this.eat(T.Star)) {
          dimensions.push({
            lower: undefined,
            upper: undefined,
            star: true,
            range: { start: ds, end: this.lastEnd },
          });
        } else {
          const lower = this.parseExpression();
          this.expect(T.Range, "'..' in the array bounds");
          const upper = this.parseExpression();
          dimensions.push({ lower, upper, star: false, range: { start: ds, end: this.lastEnd } });
        }
      } while (this.eat(T.Comma));
      this.expect(T.RBracket, "']'");
      this.expectWord('OF');
      const element = this.parseType();
      return { kind: 'array', dimensions, element, range: { start, end: this.lastEnd } };
    }
    if (w === 'STRING' || w === 'WSTRING') {
      this.next();
      let length: Expression | undefined;
      if (this.eat(T.LBracket)) {
        length = this.parseExpression();
        this.expect(T.RBracket, "']'");
      }
      return { kind: 'string', wide: w === 'WSTRING', length, range: { start, end: this.lastEnd } };
    }
    if (w === 'STRUCT') return this.parseStruct();
    if (w === 'REF_TO') {
      this.next();
      const target = this.parseType();
      return { kind: 'ref', target, range: { start, end: this.lastEnd } };
    }
    if (t.kind === T.Quoted || t.kind === T.Identifier) {
      const path: Name[] = [this.nameFrom(this.next())];
      let rooted = false;
      if (path[0]!.text === '_' && !path[0]!.quoted) {
        rooted = true;
        path.pop();
        this.expect(T.Dot, "'.' after '_'");
        const n = this.parseName('a type name');
        if (n) path.push(n);
      }
      while (
        this.at(T.Dot) &&
        (this.peek(1).kind === T.Identifier || this.peek(1).kind === T.Quoted)
      ) {
        this.next();
        path.push(this.nameFrom(this.next()));
      }
      const named: NamedType = { kind: 'named', path, rooted, range: { start, end: this.lastEnd } };
      return named;
    }
    this.error(this.here(), 'Expected a data type.');
    return { kind: 'error', range: this.here() };
  }

  private parseStruct(): StructType {
    const opener = this.next(); // STRUCT
    const members = this.parseMembers('END_STRUCT');
    this.expectWord('END_STRUCT');
    return { kind: 'struct', members, range: { start: opener.start, end: this.lastEnd } };
  }

  /** Member declarations until the given closing word (END_VAR, END_STRUCT). */
  parseMembers(closer: string): Member[] {
    const members: Member[] = [];
    for (;;) {
      if (this.at(T.EOF) || this.atWord(closer) || this.atBlockBoundary()) break;
      const start = this.tok().start;
      const before = this.pos;
      const member = this.parseMember();
      if (member) members.push(member);
      if (this.pos === before) {
        const bad = this.next();
        this.markNotAnalyzed({ start: bad.start, end: bad.end }, 'declaration');
      } else if (!member) {
        this.markNotAnalyzed({ start, end: this.lastEnd }, 'declaration');
      }
    }
    return members;
  }

  private atBlockBoundary(): boolean {
    const w = this.word();
    return (
      w in SECTION_KEYWORDS ||
      w === 'BEGIN' ||
      w === 'NETWORK' ||
      (CLOSERS.has(w) && w !== 'END_STRUCT')
    );
  }

  private parseMember(): Member | undefined {
    const start = this.tok().start;
    let attributeBlock: AttributeBlock | undefined;
    if (this.at(T.LBrace)) attributeBlock = this.parseAttributeBlock();
    if (!this.at(T.Identifier) && !this.at(T.Quoted)) {
      if (attributeBlock) return undefined;
      this.skipToStatementEnd();
      return undefined;
    }
    const name = this.nameFrom(this.next());
    if (this.at(T.LBrace)) attributeBlock = this.parseAttributeBlock(); // external source style
    let at: Name | undefined;
    if (this.eatWord('AT')) {
      // external sources overlay a variable (x AT y); SIMATIC SD only allows an I/Q/M address
      const t = this.tok();
      if (t.kind === T.Address) {
        this.next();
        at = { text: this.text(t), quoted: false, range: { start: t.start, end: t.end } };
      } else {
        at = this.parseName('the overlaid variable');
      }
    }
    if (!this.expect(T.Colon, "':' after the member name")) {
      this.skipToStatementEnd();
      return undefined;
    }
    const type = this.parseType();
    let initial: Expression | undefined;
    if (this.eat(T.Assign)) initial = this.parseExpression();
    this.terminate();
    const end = this.lastEnd;
    const comment = this.trailingComment();
    return {
      name,
      type,
      initial,
      attributes: attributeBlock?.attributes ?? [],
      attributeBlock,
      at,
      comment,
      range: { start, end },
    };
  }

  /** A // comment on the same line, right after the last consumed token. */
  private trailingComment(): { text: string; range: Range } | undefined {
    let i = this.pos;
    while (this.tokens[i]!.kind === T.Whitespace) i++;
    const t = this.tokens[i]!;
    if (t.kind !== T.LineComment) return undefined;
    const raw = this.source.text.slice(t.start, t.end);
    return { text: raw.replace(/^\/\/\s?/, '').trim(), range: { start: t.start, end: t.end } };
  }

  parseSection(): VarSection {
    const header = this.next();
    const keyword = this.text(header).toUpperCase();
    let kind: SectionKind = SECTION_KEYWORDS[keyword] ?? 'Static';
    const modifiers: string[] = [];
    while (SECTION_MODIFIERS.has(this.word()) && !this.newlineBefore()) {
      const m = this.word();
      modifiers.push(m);
      if (m === 'CONSTANT') kind = 'Constant';
      this.next();
    }
    const headerRange = { start: header.start, end: this.lastEnd };
    const members = this.parseMembers('END_VAR');
    this.expectWord('END_VAR');
    this.optionalSemicolon();
    return {
      kind,
      keyword,
      modifiers,
      members,
      headerRange,
      range: { start: header.start, end: this.lastEnd },
    };
  }

  // --- LAD / FBD ---------------------------------------------------------------------------------

  private isWire(t: Token): boolean {
    return t.kind === T.TypedLiteral && /^wire#/i.test(this.text(t));
  }

  private wireName(t: Token): string {
    return this.text(t).slice(5);
  }

  parseLadder(): LadderBody {
    const labels: LadderLabel[] = [];
    const rungs: Rung[] = [];
    for (;;) {
      if (this.at(T.EOF) || this.atWord('END_NETWORK') || this.atBlockEnd()) break;
      if (this.atWord('LABEL') && this.peek(1).kind === T.LParen) {
        const start = this.next().start;
        this.next();
        const name = this.parseName('a label name');
        this.expect(T.RParen, "')'");
        if (name) labels.push({ name, range: { start, end: this.lastEnd } });
        continue;
      }
      if (this.atWord('RUNG')) {
        rungs.push(this.parseRung());
        continue;
      }
      const start = this.tok().start;
      while (!this.at(T.EOF) && !this.atWord('RUNG', 'END_NETWORK', 'LABEL') && !this.atBlockEnd())
        this.next();
      this.markNotAnalyzed({ start, end: this.lastEnd }, 'network content');
    }
    return { labels, rungs };
  }

  private atBlockEnd(): boolean {
    return Object.values(BLOCK_END).includes(this.word()) || this.atWord('END_NAMESPACE');
  }

  private parseRung(): Rung {
    const opener = this.next(); // RUNG
    let start: RungStart;
    const t = this.tok();
    if (this.isWire(t) && !this.newlineBefore()) {
      this.next();
      const name = this.wireName(t);
      start =
        name.toLowerCase() === 'powerrail'
          ? { kind: 'powerrail', range: { start: t.start, end: t.end } }
          : { kind: 'wire', name, range: { start: t.start, end: t.end } };
    } else if (this.newlineBefore() || this.atWord('END_RUNG') || this.at(T.LBrace)) {
      start = { kind: 'none', range: { start: opener.end, end: opener.end } };
    } else {
      const operand = this.parseUnary();
      start = { kind: 'operand', operand, range: operand.range };
    }
    const items: RungItem[] = [];
    let templates: Attribute[] = [];
    for (;;) {
      const c = this.tok();
      if (c.kind === T.EOF || this.atWord('END_RUNG', 'END_NETWORK', 'RUNG') || this.atBlockEnd())
        break;
      if (this.isWire(c)) {
        this.next();
        items.push({
          kind: 'junction',
          name: this.wireName(c),
          range: { start: c.start, end: c.end },
        });
        continue;
      }
      if (this.at(T.LBrace)) {
        templates = this.parseAttributeBlock().attributes;
        continue;
      }
      const element = this.parseLadderElement(templates);
      templates = [];
      if (element) items.push(element);
    }
    let end: Rung['end'];
    if (this.eatWord('END_RUNG')) {
      const e = this.tok();
      if (this.isWire(e) && !this.newlineBefore()) {
        this.next();
        end = { name: this.wireName(e), range: { start: e.start, end: e.end } };
      }
    } else {
      this.error(this.lastRange(), 'Missing END_RUNG.');
    }
    return { start, items, end, range: { start: opener.start, end: this.lastEnd } };
  }

  private parseLadderElement(templates: Attribute[]): LadderElement | undefined {
    const start = this.tok().start;
    const negated = !!this.eatWord('NOT');
    const t = this.tok();
    if (t.kind !== T.Identifier && t.kind !== T.Hash && t.kind !== T.Quoted) {
      const bad = this.next();
      this.markNotAnalyzed({ start: bad.start, end: bad.end }, 'rung element');
      return undefined;
    }
    const callee = this.parsePostfix(false);
    const instruction = calleeName(callee);
    if (!this.at(T.LParen)) {
      this.error(this.lastRange(), `Expected '(' after ${instruction}.`);
      return undefined;
    }
    const call = this.parseCallArgs(callee);
    return {
      kind: 'element',
      negated,
      callee,
      instruction,
      templates,
      args: call.args,
      range: { start, end: this.lastEnd },
    };
  }

  // --- Networks and blocks -------------------------------------------------------------------------

  private parseNetwork(
    attributeBlock: AttributeBlock | undefined,
    index: number,
    defaultLanguage: NetworkLanguage,
  ): Network {
    const keyword = this.next(); // NETWORK
    const attrs = attributeBlock?.attributes ?? [];
    const lang = attrs.find((a) => a.name === 'S7_Language')?.value.toUpperCase();
    const language: NetworkLanguage =
      lang === undefined
        ? defaultLanguage
        : lang === 'SCL' || lang === 'LAD' || lang === 'FBD'
          ? lang
          : lang.startsWith('F_')
            ? (lang.slice(2) as NetworkLanguage)
            : 'unknown';
    const bodyStart = keyword.end;
    let statements: Statement[] | undefined;
    let ladder: LadderBody | undefined;
    if (language === 'SCL') {
      statements = this.parseStatements();
    } else if (language === 'LAD' || language === 'FBD') {
      ladder = this.parseLadder();
    } else {
      const start = this.tok().start;
      while (!this.at(T.EOF) && !this.atWord('END_NETWORK') && !this.atBlockEnd()) this.next();
      this.markNotAnalyzed(
        { start, end: this.lastEnd },
        `network in ${lang ?? 'an unknown language'}`,
      );
    }
    const bodyEnd = this.tok().start;
    if (!this.eatWord('END_NETWORK')) this.error(this.lastRange(), 'Missing END_NETWORK.');
    return {
      index,
      language,
      attributeBlock,
      titleId: attrs.find((a) => a.name === 'S7_NetworkTitle')?.value,
      commentId: attrs.find((a) => a.name === 'S7_NetworkComment')?.value,
      keywordRange: { start: keyword.start, end: keyword.end },
      bodyRange: { start: bodyStart, end: bodyEnd },
      statements,
      ladder,
      range: { start: attributeBlock?.range.start ?? keyword.start, end: this.lastEnd },
    };
  }

  /** DB start values: assignments until the end of the block. */
  private parseStartValues(closer: string): Assignment[] {
    const values: Assignment[] = [];
    while (!this.at(T.EOF) && !this.atWord(closer) && !this.atBlockEnd()) {
      const before = this.pos;
      const s = this.parseStatement();
      if (s.kind === 'assign') values.push(s);
      else if (s.kind !== 'empty' && s.kind !== 'notAnalyzed')
        this.markNotAnalyzed(s.range, 'start value');
      if (this.pos === before) this.next();
    }
    return values;
  }

  // --- SIMATIC SD document -------------------------------------------------------------------------------

  parseS7dcl(): BlockFile {
    let namespace: BlockFile['namespace'];
    if (this.atWord('NAMESPACE')) {
      const kw = this.next();
      const n = this.restOfLine();
      namespace = { name: n.text, range: { start: kw.start, end: n.range.end } };
    }
    const blocks: Block[] = [];
    while (!this.at(T.EOF) && !this.atWord('END_NAMESPACE')) {
      const before = this.pos;
      const block = this.parseS7dclBlock(namespace?.name);
      if (block) blocks.push(block);
      if (this.pos === before) {
        const start = this.tok().start;
        while (
          !this.at(T.EOF) &&
          !this.at(T.LBrace) &&
          !(this.word() in BLOCK_KEYWORDS) &&
          !this.atWord('END_NAMESPACE')
        )
          this.next();
        if (this.pos === before) this.next();
        this.markNotAnalyzed({ start, end: this.lastEnd }, 'text outside a block');
      }
    }
    if (namespace) {
      if (!this.eatWord('END_NAMESPACE')) this.error(this.lastRange(), 'Missing END_NAMESPACE.');
    }
    this.trailingText();
    return this.result('s7dcl', blocks, namespace);
  }

  private parseS7dclBlock(namespace: string | undefined): Block | undefined {
    const start = this.tok().start;
    let attributeBlock: AttributeBlock | undefined;
    if (this.at(T.LBrace)) attributeBlock = this.parseAttributeBlock();
    const kind = BLOCK_KEYWORDS[this.word()];
    if (!kind) {
      if (attributeBlock) this.markNotAnalyzed(attributeBlock.range, 'attributes without a block');
      return undefined;
    }
    this.next();
    if (kind === 'UDT') return this.parseS7dclType(start, namespace);
    const name = this.parseName('the block name') ?? {
      text: '',
      quoted: false,
      range: this.here(),
    };
    let returnType: TypeNode | undefined;
    let dbType: TypeNode | undefined;
    if (kind === 'FC' && this.eat(T.Colon)) returnType = this.parseType();
    if (kind === 'DB' && this.eat(T.Colon)) dbType = this.parseType();
    const sections: VarSection[] = [];
    while (this.word() in SECTION_KEYWORDS) sections.push(this.parseSection());
    const attrs = attributeBlock?.attributes ?? [];
    const editor = attrs
      .find((a) => a.name === 'S7_EditorMode' || a.name === 'S7_PreferredLanguage')
      ?.value.toUpperCase();
    const defaultLanguage: NetworkLanguage = editor === 'LAD' || editor === 'FBD' ? editor : 'SCL';
    const networks: Network[] = [];
    let startValues: Assignment[] = [];
    let codeStart = this.tok().start;
    for (;;) {
      let netAttrs: AttributeBlock | undefined;
      const save = this.pos;
      if (this.at(T.LBrace)) netAttrs = this.parseAttributeBlock();
      if (this.atWord('NETWORK')) {
        if (networks.length === 0) codeStart = netAttrs?.range.start ?? this.tok().start;
        networks.push(this.parseNetwork(netAttrs, networks.length + 1, defaultLanguage));
        continue;
      }
      if (netAttrs) {
        this.pos = save;
        break;
      }
      break;
    }
    if (kind === 'DB') {
      if (networks.length === 0) codeStart = this.tok().start;
      startValues = this.parseStartValues(BLOCK_END[kind]);
    }
    if (!this.eatWord(BLOCK_END[kind])) {
      this.error(this.lastRange(), `Missing ${BLOCK_END[kind]}.`);
      this.skipToBlockEnd(kind);
    }
    return {
      kind,
      name,
      namespace,
      attributes: attrs,
      attributeBlock,
      returnType,
      dbType,
      title: undefined,
      version: attrs.find((a) => a.name === 'S7_Version')?.value,
      sections,
      struct: undefined,
      networks,
      startValues,
      codeStart,
      range: { start, end: this.lastEnd },
    };
  }

  private skipToBlockEnd(kind: BlockKind): void {
    const start = this.tok().start;
    while (!this.at(T.EOF) && !this.atWord(BLOCK_END[kind]) && !this.atWord('END_NAMESPACE'))
      this.next();
    if (this.lastEnd > start) this.markNotAnalyzed({ start, end: this.lastEnd }, 'block content');
    this.eatWord(BLOCK_END[kind]);
  }

  /** TYPE [{attrs}] Name : STRUCT ... END_STRUCT; END_TYPE */
  private parseS7dclType(start: number, namespace: string | undefined): Block {
    let attributeBlock: AttributeBlock | undefined;
    if (this.at(T.LBrace)) attributeBlock = this.parseAttributeBlock();
    const name = this.parseName('the type name') ?? { text: '', quoted: false, range: this.here() };
    this.expect(T.Colon, "':' after the type name");
    const type = this.parseType();
    this.optionalSemicolon();
    if (!this.eatWord('END_TYPE')) {
      this.error(this.lastRange(), 'Missing END_TYPE.');
      this.skipToBlockEnd('UDT');
    }
    return this.typeBlock(start, name, namespace, attributeBlock, type, undefined, undefined);
  }

  private typeBlock(
    start: number,
    name: Name,
    namespace: string | undefined,
    attributeBlock: AttributeBlock | undefined,
    type: TypeNode,
    title: Block['title'],
    version: string | undefined,
  ): Block {
    const attrs = attributeBlock?.attributes ?? [];
    return {
      kind: 'UDT',
      name,
      namespace,
      attributes: attrs,
      attributeBlock,
      returnType: undefined,
      dbType: undefined,
      title,
      version: version ?? attrs.find((a) => a.name === 'S7_Version')?.value,
      sections: [],
      struct: type.kind === 'struct' ? type : undefined,
      networks: [],
      startValues: [],
      codeStart: this.lastEnd,
      range: { start, end: this.lastEnd },
    };
  }

  // --- External source -----------------------------------------------------------------------------------

  parseSource(): BlockFile {
    let namespace: BlockFile['namespace'];
    let currentNamespace: string | undefined;
    const blocks: Block[] = [];
    while (!this.at(T.EOF)) {
      if (this.atWord('NAMESPACE')) {
        const kw = this.next();
        const n = this.restOfLine();
        currentNamespace = n.text;
        namespace ??= { name: n.text, range: { start: kw.start, end: n.range.end } };
        continue;
      }
      if (this.eatWord('END_NAMESPACE')) {
        currentNamespace = undefined;
        continue;
      }
      const kind = BLOCK_KEYWORDS[this.word()];
      if (!kind) {
        const start = this.tok().start;
        while (
          !this.at(T.EOF) &&
          !(this.word() in BLOCK_KEYWORDS) &&
          !this.atWord('NAMESPACE', 'END_NAMESPACE')
        )
          this.next();
        this.markNotAnalyzed({ start, end: this.lastEnd }, 'text outside a block');
        continue;
      }
      blocks.push(this.parseSourceBlock(kind, currentNamespace));
    }
    return this.result('source', blocks, namespace);
  }

  private parseSourceBlock(kind: BlockKind, namespace: string | undefined): Block {
    const opener = this.next();
    const name = this.parseName('the block name') ?? {
      text: '',
      quoted: false,
      range: this.here(),
    };
    let returnType: TypeNode | undefined;
    if (kind === 'FC' && this.eat(T.Colon)) returnType = this.parseType();
    let title: Block['title'];
    let version: string | undefined;
    let attributeBlock: AttributeBlock | undefined;
    const extraAttributes: Attribute[] = [];
    // header: TITLE, attributes, AUTHOR/FAMILY/NAME/VERSION, NON_RETAIN, KNOW_HOW_PROTECT
    for (;;) {
      const w = this.word();
      if (w === 'TITLE' && this.peek(1).kind === T.Eq) {
        this.next();
        this.next();
        const rest = this.restOfLine();
        title = { text: rest.text, range: rest.range };
      } else if (this.at(T.LBrace)) {
        attributeBlock = this.parseAttributeBlock();
      } else if (
        (w === 'VERSION' || w === 'AUTHOR' || w === 'FAMILY' || w === 'NAME') &&
        this.peek(1).kind === T.Colon
      ) {
        const kw = this.next();
        this.next();
        const rest = this.restOfLine();
        if (w === 'VERSION') version = rest.text;
        extraAttributes.push({
          name: w,
          value: rest.text,
          nameRange: { start: kw.start, end: kw.end },
          valueRange: rest.range,
          range: { start: kw.start, end: rest.range.end },
        });
      } else if (
        w === 'NON_RETAIN' ||
        w === 'RETAIN' ||
        w === 'KNOW_HOW_PROTECT' ||
        w === 'DB_SPECIFIC' ||
        w === 'READ_ONLY' ||
        w === 'UNLINKED'
      ) {
        const kw = this.next();
        extraAttributes.push({
          name: w,
          value: 'TRUE',
          nameRange: { start: kw.start, end: kw.end },
          valueRange: { start: kw.start, end: kw.end },
          range: { start: kw.start, end: kw.end },
        });
      } else {
        break;
      }
    }
    const attributes = [...(attributeBlock?.attributes ?? []), ...extraAttributes];
    if (kind === 'UDT') {
      const type = this.atWord('STRUCT') ? this.parseStruct() : this.parseType();
      this.optionalSemicolon();
      if (!this.eatWord('END_TYPE')) {
        this.error(this.lastRange(), 'Missing END_TYPE.');
        this.skipToBlockEnd('UDT');
      }
      const block = this.typeBlock(
        opener.start,
        name,
        namespace,
        attributeBlock,
        type,
        title,
        version,
      );
      return { ...block, attributes };
    }
    let dbType: TypeNode | undefined;
    let struct: StructType | undefined;
    if (kind === 'DB') {
      if (this.atWord('STRUCT')) {
        struct = this.parseStruct();
        this.optionalSemicolon();
      } else if (!(this.word() in SECTION_KEYWORDS) && !this.atWord('BEGIN')) {
        dbType = this.parseType();
        this.optionalSemicolon();
      }
    }
    const sections: VarSection[] = [];
    while (this.word() in SECTION_KEYWORDS) sections.push(this.parseSection());
    const networks: Network[] = [];
    let startValues: Assignment[] = [];
    const codeStart = this.tok().start;
    const begin = this.eatWord('BEGIN');
    if (begin) {
      if (kind === 'DB') {
        startValues = this.parseStartValues(BLOCK_END[kind]);
      } else {
        const statements = this.parseStatements();
        networks.push({
          index: 1,
          language: 'SCL',
          attributeBlock: undefined,
          titleId: undefined,
          commentId: undefined,
          keywordRange: { start: begin.start, end: begin.end },
          bodyRange: { start: begin.end, end: this.tok().start },
          statements,
          ladder: undefined,
          range: { start: begin.start, end: this.tok().start },
        });
      }
    } else if (kind !== 'DB') {
      this.error(this.lastRange(), 'Missing BEGIN.');
    }
    if (!this.eatWord(BLOCK_END[kind])) {
      this.error(this.lastRange(), `Missing ${BLOCK_END[kind]}.`);
      this.skipToBlockEnd(kind);
    }
    return {
      kind,
      name,
      namespace,
      attributes,
      attributeBlock,
      returnType,
      dbType,
      title,
      version,
      sections,
      struct,
      networks,
      startValues,
      codeStart,
      range: { start: opener.start, end: this.lastEnd },
    };
  }

  private trailingText(): void {
    const start = this.tok().start;
    if (this.at(T.EOF)) return;
    while (!this.at(T.EOF)) this.next();
    this.markNotAnalyzed({ start, end: this.lastEnd }, 'text after the block');
  }

  private result(
    format: BlockFileFormat,
    blocks: Block[],
    namespace: BlockFile['namespace'],
  ): BlockFile {
    return {
      kind: 'blocks',
      format,
      source: this.source,
      tokens: this.tokens,
      blocks,
      namespace,
      diagnostics: this.diagnostics,
      notAnalyzed: this.notAnalyzed,
    };
  }
}

/** Display name of a callee: Contact, TON (#Delay.TON), Sections (#Sections), FC_X ("FC_X"). */
export function calleeName(callee: Expression): string {
  switch (callee.kind) {
    case 'name':
    case 'local':
    case 'global':
      return callee.name.text;
    case 'member':
      return callee.member.text;
    default:
      return '';
  }
}

export function parseBlockFile(source: SourceText, format: BlockFileFormat): BlockFile {
  const parser = new Parser(source);
  return format === 's7dcl' ? parser.parseS7dcl() : parser.parseSource();
}

export function parseBlockText(text: string, format: BlockFileFormat): BlockFile {
  return parseBlockFile(new SourceText(text), format);
}
