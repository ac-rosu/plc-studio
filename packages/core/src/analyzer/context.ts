// What the analyzer rules share: fast lookup of the binder's references by position, member
// declarations by id with their types, a light expression typing, and AST walking helpers.
import type { ProjectAnalysis } from '../check/analysis.ts';
import type { Reference } from '../check/binder.ts';
import type { BlockSymbol, Project } from '../model/project.ts';
import { classOf, membersOf, type DataType, type MemberInfo } from '../model/types.ts';
import type { Expression, Statement } from '../syntax/ast.ts';

export class AnalyzerContext {
  readonly project: Project;
  readonly analysis: ProjectAnalysis;
  private refsByFile: Map<string, Map<number, Reference>> | undefined;
  private members: Map<string, MemberInfo> | undefined;

  constructor(project: Project, analysis: ProjectAnalysis) {
    this.project = project;
    this.analysis = analysis;
  }

  /** The reference whose range starts at the offset (references are recorded on names). */
  referenceStartingAt(file: string, offset: number): Reference | undefined {
    if (!this.refsByFile) {
      this.refsByFile = new Map();
      for (const r of this.analysis.references) {
        let m = this.refsByFile.get(r.file);
        if (!m) this.refsByFile.set(r.file, (m = new Map()));
        // keep the first; declarations and uses never start at the same offset twice
        if (!m.has(r.range.start)) m.set(r.range.start, r);
      }
    }
    return this.refsByFile.get(file)?.get(offset);
  }

  /** The reference an expression denotes as a whole (its last name). */
  referenceOf(file: string, e: Expression): Reference | undefined {
    switch (e.kind) {
      case 'local':
      case 'global':
      case 'name':
        return this.referenceStartingAt(file, e.name.range.start);
      case 'member':
        return this.referenceStartingAt(file, e.member.range.start);
      case 'paren':
        return this.referenceOf(file, e.inner);
      default:
        return undefined;
    }
  }

  /** The variable an expression starts from: #a for #a.b[1]^ (the root of a write or read). */
  rootReference(file: string, e: Expression): Reference | undefined {
    switch (e.kind) {
      case 'local':
      case 'global':
      case 'name':
        return this.referenceStartingAt(file, e.name.range.start);
      case 'member':
      case 'index':
      case 'deref':
        return this.rootReference(file, e.object);
      case 'paren':
        return this.rootReference(file, e.inner);
      default:
        return undefined;
    }
  }

  /** Every member declaration of the project by id, with its resolved type. */
  member(id: string): MemberInfo | undefined {
    if (!this.members) {
      this.members = new Map();
      const index = this.project.index;
      const visit = (list: readonly MemberInfo[], depth: number) => {
        for (const m of list) {
          if (this.members!.has(m.id)) continue;
          this.members!.set(m.id, m);
          if (depth < 6 && m.type.kind === 'struct') visit(m.type.members, depth + 1);
          if (depth < 6 && m.type.kind === 'array' && m.type.element.kind === 'struct')
            visit(m.type.element.members, depth + 1);
        }
      };
      for (const b of index.blocks) {
        if (b.kind === 'UDT') {
          const t = index.udtType(b);
          visit(membersOf(t) ?? [], 0);
        } else if (b.kind === 'DB') {
          visit(index.dbMembers(b), 0);
        } else {
          visit(index.interfaceMembers(b), 0);
        }
      }
    }
    return this.members.get(id);
  }

  /** Type of an expression, as far as the analyzer needs it (unknown when unsure). */
  typeOf(file: string, e: Expression): DataType | 'real-literal' | 'int-literal' | undefined {
    switch (e.kind) {
      case 'literal':
        if (e.literalKind === 'real') return 'real-literal';
        if (e.literalKind === 'int') return 'int-literal';
        if (e.literalKind === 'typed') {
          const info = this.project.profile.literalType(e.prefix ?? '');
          return info ? { kind: 'elementary', name: info.name, info } : undefined;
        }
        return undefined;
      case 'paren':
        return this.typeOf(file, e.inner);
      case 'unary':
        return this.typeOf(file, e.operand);
      case 'local':
      case 'global':
      case 'member': {
        const r = this.referenceOf(file, e);
        if (!r) return undefined;
        if (r.symbolKind === 'member') return this.member(r.symbolId)?.type;
        if (r.symbolKind === 'tag' || r.symbolKind === 'constant') {
          const tag = this.project.index.tags.find((t) => t.id === r.symbolId);
          return tag ? this.project.index.tagType(tag) : undefined;
        }
        return undefined;
      }
      case 'index': {
        const t = this.typeOf(file, e.object);
        return t && typeof t !== 'string' && t.kind === 'array' ? t.element : undefined;
      }
      case 'binary': {
        if (['+', '-', '*', '/', '**'].includes(e.op)) {
          const l = this.typeOf(file, e.left);
          const r = this.typeOf(file, e.right);
          if (isReal(l) || isReal(r)) return 'real-literal';
          return l ?? r;
        }
        return undefined;
      }
      case 'call': {
        const name = e.callee.kind === 'name' ? e.callee.name.text : undefined;
        const conversion = name ? this.project.profile.conversion(name) : undefined;
        if (conversion)
          return { kind: 'elementary', name: conversion.to.name, info: conversion.to };
        return undefined;
      }
      default:
        return undefined;
    }
  }

  blockSymbol(id: string): BlockSymbol | undefined {
    return this.project.index.block(id);
  }

  text(file: string, start: number, end: number): string {
    return this.project.files.get(file)?.source.text.slice(start, end) ?? '';
  }

  line(file: string, offset: number): number {
    return (this.project.files.get(file)?.source.positionAt(offset).line ?? 0) + 1;
  }
}

export function isReal(t: DataType | 'real-literal' | 'int-literal' | undefined): boolean {
  if (t === 'real-literal') return true;
  if (!t || typeof t === 'string') return false;
  return classOf(t) === 'real';
}

/** Direct child statement lists of a statement. */
export function childLists(s: Statement): readonly (readonly Statement[])[] {
  switch (s.kind) {
    case 'if':
      return [...s.branches.map((b) => b.body), ...(s.elseBody ? [s.elseBody] : [])];
    case 'case':
      return [...s.clauses.map((c) => c.body), ...(s.elseBody ? [s.elseBody] : [])];
    case 'for':
    case 'while':
    case 'repeat':
    case 'region':
      return [s.body];
    default:
      return [];
  }
}

/** Every statement, depth first. */
export function* allStatements(list: readonly Statement[]): Generator<Statement> {
  for (const s of list) {
    yield s;
    for (const child of childLists(s)) yield* allStatements(child);
  }
}

/** Expressions directly inside a statement (not inside nested statements). */
export function statementExpressions(s: Statement): Expression[] {
  switch (s.kind) {
    case 'assign':
      return [s.target, s.value];
    case 'callStatement':
      return [s.call];
    case 'if':
      return s.branches.map((b) => b.condition);
    case 'case':
      return [
        s.selector,
        ...s.clauses.flatMap((c) => c.labels.flatMap((l) => (l.to ? [l.from, l.to] : [l.from]))),
      ];
    case 'for':
      return [s.variable, s.from, s.to, ...(s.by ? [s.by] : [])];
    case 'while':
    case 'repeat':
      return [s.condition];
    default:
      return [];
  }
}

/** Every sub-expression, depth first. */
export function* subExpressions(e: Expression): Generator<Expression> {
  yield e;
  switch (e.kind) {
    case 'member':
    case 'index':
    case 'deref':
      yield* subExpressions(e.object);
      if (e.kind === 'index') for (const i of e.indexes) yield* subExpressions(i);
      return;
    case 'call':
      yield* subExpressions(e.callee);
      for (const a of e.args) yield* subExpressions(a.value);
      return;
    case 'unary':
      yield* subExpressions(e.operand);
      return;
    case 'binary':
      yield* subExpressions(e.left);
      yield* subExpressions(e.right);
      return;
    case 'paren':
      yield* subExpressions(e.inner);
      return;
    case 'arrayLiteral':
      for (const i of e.items) yield* subExpressions(i);
      return;
    default:
      return;
  }
}
