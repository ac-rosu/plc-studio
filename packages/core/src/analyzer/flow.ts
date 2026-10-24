// Definite assignment along the statements of a block: which variables are certainly written on
// every path that reaches a point. Drives "Temp read before written", "FC output not written on
// every path", "output assigned twice" and "FOR counter used after the loop".
import type { Expression, Statement } from '../syntax/ast.ts';
import type { Range } from '../text/source-text.ts';
import type { AnalyzerContext } from './context.ts';

/** null = the path has ended (RETURN, EXIT, CONTINUE): it constrains nothing after it. */
type State = Set<string> | null;

export interface FlowEvents {
  /** A variable (root symbol id) is read; `assigned`: certainly written before on every path. */
  read?(id: string, range: Range, assigned: boolean): void;
  /** A variable is written; `alreadyAssigned`: written before on every path to here. */
  write?(id: string, range: Range, alreadyAssigned: boolean, inLoop: boolean): void;
  /** The block is left by RETURN; `state`: what is certainly written at that point. */
  leave?(state: ReadonlySet<string>, range: Range): void;
  /** A FOR loop over this counter has ended. */
  loopEnded?(counterId: string): void;
}

export class Flow {
  private readonly ctx: AnalyzerContext;
  private readonly file: string;
  private readonly events: FlowEvents;
  private loopDepth = 0;

  constructor(ctx: AnalyzerContext, file: string, events: FlowEvents) {
    this.ctx = ctx;
    this.file = file;
    this.events = events;
  }

  /** Runs over a statement list from an empty state; returns the state at its normal end. */
  run(list: readonly Statement[]): Set<string> | null {
    return this.list(list, new Set());
  }

  private list(list: readonly Statement[], state: State): State {
    for (const s of list) {
      if (state === null) return null;
      state = this.statement(s, state);
    }
    return state;
  }

  private sub(list: readonly Statement[], state: Set<string>): State {
    return this.list(list, new Set(state));
  }

  private join(outs: State[]): State {
    const live = outs.filter((o): o is Set<string> => o !== null);
    if (live.length === 0) return null;
    const first = live[0]!;
    return new Set([...first].filter((id) => live.every((o) => o.has(id))));
  }

  private statement(s: Statement, state: Set<string>): State {
    switch (s.kind) {
      case 'assign':
        this.reads(s.value, state);
        if (s.op !== ':=') this.reads(s.target, state);
        this.write(s.target, state);
        return state;
      case 'callStatement':
        this.reads(s.call, state);
        return state;
      case 'if': {
        const outs: State[] = [];
        for (const b of s.branches) {
          this.reads(b.condition, state);
          outs.push(this.sub(b.body, state));
        }
        outs.push(s.elseBody ? this.sub(s.elseBody, state) : new Set(state));
        return this.join(outs);
      }
      case 'case': {
        this.reads(s.selector, state);
        const outs = s.clauses.map((c) => this.sub(c.body, state));
        outs.push(s.elseBody ? this.sub(s.elseBody, state) : new Set(state));
        return this.join(outs);
      }
      case 'for': {
        this.reads(s.from, state);
        this.reads(s.to, state);
        if (s.by) this.reads(s.by, state);
        this.write(s.variable, state);
        this.loopDepth++;
        this.sub(s.body, state);
        this.loopDepth--;
        const counter = this.ctx.rootReference(this.file, s.variable);
        if (counter) this.events.loopEnded?.(counter.symbolId);
        return state;
      }
      case 'while':
        this.reads(s.condition, state);
        this.loopDepth++;
        this.sub(s.body, state);
        this.loopDepth--;
        return state;
      case 'repeat': {
        this.loopDepth++;
        const after = this.list(s.body, new Set(state));
        this.loopDepth--;
        const next = after ?? state;
        this.reads(s.condition, next);
        return next;
      }
      case 'region':
        return this.list(s.body, state);
      case 'return':
        this.events.leave?.(state, s.range);
        return null;
      case 'exit':
      case 'continue':
        return null;
      default:
        return state;
    }
  }

  private reads(e: Expression | undefined, state: Set<string>): void {
    if (!e) return;
    switch (e.kind) {
      case 'local':
      case 'global':
      case 'name': {
        const r = this.ctx.referenceStartingAt(this.file, e.name.range.start);
        if (
          r &&
          r.access !== 'declaration' &&
          (r.symbolKind === 'member' || r.symbolKind === 'tag')
        ) {
          this.events.read?.(r.symbolId, e.range, state.has(r.symbolId));
        }
        return;
      }
      case 'member':
      case 'index':
      case 'deref': {
        // reading #a.b reads the root #a
        const root = this.ctx.rootReference(this.file, e);
        if (root && root.symbolKind === 'member')
          this.events.read?.(root.symbolId, e.range, state.has(root.symbolId));
        if (e.kind === 'index') for (const i of e.indexes) this.reads(i, state);
        return;
      }
      case 'call':
        this.call(e, state);
        return;
      case 'unary':
        this.reads(e.operand, state);
        return;
      case 'binary':
        this.reads(e.left, state);
        this.reads(e.right, state);
        return;
      case 'paren':
        this.reads(e.inner, state);
        return;
      case 'arrayLiteral':
      case 'structLiteral':
        for (const i of e.items) this.reads(i, state);
        return;
      default:
        return;
    }
  }

  private call(e: Expression & { kind: 'call' }, state: Set<string>): void {
    const name = e.callee.kind === 'name' ? e.callee.name.text.toUpperCase() : '';
    // REF(#x) takes an address; it neither reads nor writes the value
    if (name === 'REF') return;
    for (const a of e.args) {
      if (a.direction === 'out') {
        this.write(a.value, state);
      } else {
        this.reads(a.value, state);
        if (this.isInOut(e, a.name?.text)) this.write(a.value, state);
      }
    }
  }

  private isInOut(e: Expression & { kind: 'call' }, param: string | undefined): boolean {
    if (!param) return false;
    const callee = this.ctx.referenceOf(this.file, e.callee);
    if (!callee) return false;
    let block = callee.symbolKind === 'block' ? this.ctx.blockSymbol(callee.symbolId) : undefined;
    if (block?.kind === 'DB') block = undefined;
    if (!block && callee.symbolKind === 'member') {
      const t = this.ctx.member(callee.symbolId)?.type;
      if (t?.kind === 'fb') block = this.ctx.blockSymbol(t.block.id);
    }
    if (!block) return false;
    return this.ctx.project.index
      .interfaceMembers(block)
      .some((m) => m.section === 'InOut' && m.name.toLowerCase() === param.toLowerCase());
  }

  private write(target: Expression, state: Set<string>): void {
    if (target.kind === 'deref') {
      // writing through a reference reads the reference itself
      this.reads(target.object, state);
      return;
    }
    if (target.kind === 'index') for (const i of target.indexes) this.reads(i, state);
    const root = this.ctx.rootReference(this.file, target);
    if (
      !root ||
      (root.symbolKind !== 'member' && root.symbolKind !== 'tag' && root.symbolKind !== 'block')
    )
      return;
    this.events.write?.(root.symbolId, target.range, state.has(root.symbolId), this.loopDepth > 0);
    state.add(root.symbolId);
  }
}

/** Runs the definite-assignment flow over a statement list. */
export function runFlow(
  ctx: AnalyzerContext,
  file: string,
  list: readonly Statement[],
  events: FlowEvents,
): Set<string> | null {
  return new Flow(ctx, file, events).run(list);
}
