// Single-block analyzer rules (spec, "Analyzer"): code TIA accepts that is likely a bug, or a
// style or complexity issue. Never errors (ADR 0003).
import type { BlockAnalysis, CallSite, Reference } from '../check/binder.ts';
import type { BlockSymbol } from '../model/project.ts';
import { membersOf, type MemberInfo } from '../model/types.ts';
import type { Expression, Statement } from '../syntax/ast.ts';
import type { Range } from '../text/source-text.ts';
import {
  allStatements,
  childLists,
  isReal,
  statementExpressions,
  subExpressions,
  type AnalyzerContext,
} from './context.ts';
import { ruleOptions, type RulesConfig } from './config.ts';
import { runFlow } from './flow.ts';

export interface Finding {
  readonly rule: string;
  readonly file: string;
  readonly range: Range;
  readonly message: string;
  /** Overrides the rule's default severity. */
  readonly severity?: 'error' | 'warning' | 'info';
}

/** Facts other passes need: FC outputs (or '#return') not written on every path. */
export interface BlockFacts {
  readonly outputsNotAlwaysWritten: ReadonlySet<string>;
}

const TIMER_INSTRUCTIONS = new Set([
  'TON',
  'TOF',
  'TP',
  'TONR',
  'CTU',
  'CTD',
  'CTUD',
  'R_TRIG',
  'F_TRIG',
]);

/** FB outputs that report errors (PLCopen-style Error / Status / ErrorID, RET_VAL). */
const STATUS_OUTPUT = /^(status|error|errorid|error_id|ret_val|retval)$/i;

const SIMATIC_TIMER_INSTRUCTIONS = new Set([
  'S_PULSE',
  'S_PEXT',
  'S_ODT',
  'S_ODTS',
  'S_OFFDT',
  'S_CU',
  'S_CD',
  'S_CUD',
]);

const EDGE_ELEMENTS = new Set(['P_CONTACT', 'N_CONTACT', 'P_COIL', 'N_COIL', 'P_TRIG', 'N_TRIG']);

/** All SCL statements of a block, network after network (they run in that order). */
export function blockStatements(symbol: BlockSymbol): Statement[] {
  return symbol.block.networks.flatMap((n) => n.statements ?? []);
}

function keywordRange(s: Statement, length: number): Range {
  return { start: s.range.start, end: Math.min(s.range.end, s.range.start + length) };
}

export class SingleBlockRules {
  private readonly ctx: AnalyzerContext;
  private readonly symbol: BlockSymbol;
  private readonly ba: BlockAnalysis;
  private readonly config: RulesConfig;
  private readonly file: string;
  private readonly findings: Finding[] = [];
  private readonly members: MemberInfo[];
  private readonly sectionOf = new Map<string, MemberInfo>();
  readonly outputsNotAlwaysWritten = new Set<string>();

  constructor(ctx: AnalyzerContext, symbol: BlockSymbol, ba: BlockAnalysis, config: RulesConfig) {
    this.ctx = ctx;
    this.symbol = symbol;
    this.ba = ba;
    this.config = config;
    this.file = symbol.file.path;
    this.members =
      symbol.kind === 'DB' || symbol.kind === 'UDT'
        ? []
        : ctx.project.index.interfaceMembers(symbol);
    for (const m of this.members) this.sectionOf.set(m.id, m);
  }

  private add(rule: string, range: Range, message: string, severity?: Finding['severity']): void {
    const line = this.ctx.line(this.file, range.start);
    // one finding per rule and line is enough
    if (
      this.findings.some(
        (f) =>
          f.rule === rule && this.ctx.line(f.file, f.range.start) === line && f.message === message,
      )
    )
      return;
    this.findings.push(
      severity
        ? { rule, file: this.file, range, message, severity }
        : { rule, file: this.file, range, message },
    );
  }

  run(): Finding[] {
    if (this.symbol.kind === 'UDT' || this.symbol.kind === 'DB') return this.findings;
    const statements = blockStatements(this.symbol);
    this.timerCalls();
    this.instanceCalledTwice();
    const hasJumps = [...allStatements(statements)].some(
      (s) => s.kind === 'goto' || s.kind === 'label',
    );
    if (!hasJumps) this.flow(statements);
    this.writeToInput();
    this.structuredParameters();
    this.globalAccess();
    this.counterThroughReference(statements);
    this.statusNotEvaluated(statements);
    this.statementRules(statements);
    this.complexity(statements);
    this.stateInTemp();
    if (!this.symbol.incomplete) this.unusedVariables();
    return this.findings;
  }

  // --- Calls ---------------------------------------------------------------------------------

  /** Conditions of a call other than the LAD/FBD power flow into a timer box (its IN). */
  private realConditions(call: CallSite): readonly string[] {
    return call.conditions.filter((c) => c !== 'EN');
  }

  private timerCalls(): void {
    for (const call of this.ba.calls) {
      const instruction = call.instruction?.toUpperCase();
      if (!call.instance || !instruction || !TIMER_INSTRUCTIONS.has(instruction)) continue;
      const conditions = this.realConditions(call);
      if (conditions.length === 0 && !call.inLoop) continue;
      const why = call.inLoop ? 'inside a loop' : `only when ${conditions[conditions.length - 1]}`;
      this.add(
        'timer-not-called-every-cycle',
        call.range,
        `#${call.instance.name} (${instruction}) is called ${why}; while the call is skipped it does not see its inputs change and stops timing or counting.`,
      );
    }
  }

  private instanceCalledTwice(): void {
    const byInstance = new Map<string, CallSite[]>();
    for (const call of this.ba.calls) {
      if (!call.instance) continue;
      const list = byInstance.get(call.instance.id) ?? [];
      list.push(call);
      byInstance.set(call.instance.id, list);
    }
    for (const calls of byInstance.values()) {
      for (const call of calls.slice(1)) {
        const first = this.ctx.line(this.file, calls[0]!.range.start);
        this.add(
          'instance-called-twice',
          call.range,
          `${call.instance!.name} is already called in line ${first}; calling one instance twice per cycle mixes the state of both calls.`,
        );
      }
    }
  }

  // --- Flow ----------------------------------------------------------------------------------

  private flow(statements: readonly Statement[]): void {
    if (statements.length === 0) return;
    // AT overlays share memory: a write to one is a write to the other. SIMATIC SD documents drop
    // the AT (format-notes 2026-10-24), so non-optimized blocks read from them are not checked.
    const overlaid = new Set<string>();
    for (const m of this.members) {
      if (m.node?.at) {
        overlaid.add(m.name.toLowerCase());
        overlaid.add(m.node.at.text.toLowerCase());
      }
    }
    const atUnknown = this.symbol.file.kind === 's7dcl' && this.symbol.optimized === false;
    const temps = new Set(
      this.members
        .filter(
          (m) =>
            m.section === 'Temp' &&
            m.type.kind !== 'system' &&
            m.type.kind !== 'fb' &&
            !overlaid.has(m.name.toLowerCase()) &&
            !atUnknown,
        )
        .map((m) => m.id),
    );
    const outputs = new Set(this.members.filter((m) => m.section === 'Output').map((m) => m.id));
    const reported = new Set<string>();
    const stale = new Set<string>();
    const fcOutputs = this.symbol.kind === 'FC' ? this.fcOutputs() : new Map<string, string>();
    const leaveMissing = new Map<string, Range>();
    const end = runFlow(this.ctx, this.file, statements, {
      read: (id, range, assigned) => {
        if (temps.has(id) && !assigned && !reported.has(id)) {
          reported.add(id);
          const name = this.sectionOf.get(id)?.name ?? id;
          this.add(
            'temp-read-before-write',
            range,
            `#${name} is a Temp and is read here before it is written; its value is undefined (or a default) at this point.`,
          );
        }
        if (stale.has(id)) {
          stale.delete(id);
          this.add(
            'for-counter-used-after-loop',
            range,
            `#${this.sectionOf.get(id)?.name ?? ''} is the counter of a FOR loop that has ended; do not rely on its value after the loop.`,
          );
        }
      },
      write: (id, range, already, inLoop) => {
        stale.delete(id);
        if (outputs.has(id) && already && !inLoop && !reported.has(`twice:${id}`)) {
          reported.add(`twice:${id}`);
          const name = this.sectionOf.get(id)?.name ?? id;
          this.add(
            'output-assigned-twice',
            range,
            `The output #${name} is assigned again in the same cycle; assign each output once.`,
          );
        }
      },
      leave: (state, range) => {
        for (const [id] of fcOutputs)
          if (!state.has(id) && !leaveMissing.has(id)) leaveMissing.set(id, range);
      },
      loopEnded: (id) => {
        if (this.sectionOf.has(id)) stale.add(id);
      },
    });
    for (const [id, name] of fcOutputs) {
      const notAtEnd = end !== null && !end.has(id);
      const atReturn = leaveMissing.get(id);
      if (!notAtEnd && !atReturn) continue;
      const written = this.ba.references.some(
        (r) => r.symbolId === id && (r.access === 'write' || r.access === 'readwrite'),
      );
      if (!written) continue; // never written at all: "unused-output"
      this.outputsNotAlwaysWritten.add(id === this.symbol.id ? '#return' : name);
      const at =
        atReturn ?? this.firstStatementWriting(statements, id) ?? this.symbol.block.name.range;
      const what = id === this.symbol.id ? 'The return value' : `The output #${name}`;
      this.add(
        'output-not-written-on-every-path',
        at,
        `${what} is not written on every path through this FC; on the other paths the caller gets an undefined value.`,
      );
    }
  }

  /** FC outputs and the return value (when not Void): id → name. */
  private fcOutputs(): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of this.members) if (m.section === 'Output') out.set(m.id, m.name);
    const rt = this.symbol.block.returnType;
    if (
      rt &&
      !(rt.kind === 'named' && rt.path.length === 1 && rt.path[0]!.text.toLowerCase() === 'void')
    )
      out.set(this.symbol.id, this.symbol.name);
    return out;
  }

  private firstStatementWriting(statements: readonly Statement[], id: string): Range | undefined {
    for (const s of statements) {
      const writes = this.ba.references.some(
        (r) =>
          r.symbolId === id &&
          (r.access === 'write' || r.access === 'readwrite') &&
          r.range.start >= s.range.start &&
          r.range.end <= s.range.end,
      );
      if (writes)
        return s.kind === 'assign' || s.kind === 'callStatement' ? s.range : keywordRange(s, 2);
    }
    return undefined;
  }

  // --- Interface use -------------------------------------------------------------------------

  private writeToInput(): void {
    for (const r of this.ba.references) {
      if (r.access !== 'write' && r.access !== 'readwrite') continue;
      const m = this.sectionOf.get(r.symbolId);
      if (m?.section !== 'Input') continue;
      this.add(
        'write-to-input',
        r.range,
        `#${m.name} is an input; writing it changes only the block's own copy, not the caller's variable.`,
      );
    }
  }

  private structuredParameters(): void {
    for (const m of this.members) {
      if (m.section !== 'Input' && m.section !== 'Output') continue;
      const k = m.type.kind;
      if (k !== 'struct' && k !== 'udt' && k !== 'array') continue;
      if (k === 'array' && m.type.star) continue;
      if (!m.declaration) continue;
      this.add(
        'structured-parameter-by-value',
        m.declaration.range,
        `#${m.name} is a structured ${m.section === 'Input' ? 'input' : 'output'}; it is copied on every call. Declare it as InOut to pass a reference instead.`,
      );
    }
  }

  private globalAccess(): void {
    if (this.symbol.kind !== 'FB' && this.symbol.kind !== 'FC') return;
    // fail-safe programs work on F-DBs by design
    if (this.symbol.failsafe) return;
    for (const r of this.ba.references) {
      if (r.access === 'declaration' || r.access === 'type') continue;
      if (r.symbolKind === 'tag') {
        this.add(
          'plc-tag-access-in-fb',
          r.range,
          `${this.symbol.kind} ${this.symbol.name} uses the PLC tag "${this.text(r)}" directly; pass it through the interface so the block stays reusable.`,
        );
      } else if (r.symbolKind === 'constant') {
        this.add(
          'global-constant-access-in-fb',
          r.range,
          `${this.symbol.kind} ${this.symbol.name} uses the global constant ${this.text(r)}; a local constant or a parameter keeps the block self-contained.`,
        );
      } else if (r.symbolKind === 'block' && r.symbolId !== this.symbol.id) {
        const target = this.ctx.blockSymbol(r.symbolId);
        if (target?.kind !== 'DB') continue;
        if (target.dbKind === 'instance') {
          this.add(
            'instance-db-access-in-fb',
            r.range,
            `${this.symbol.kind} ${this.symbol.name} uses the instance DB ${target.name} of another block; use a multi-instance or pass the data through the interface.`,
          );
        } else {
          this.add(
            'global-db-access-in-fb',
            r.range,
            `${this.symbol.kind} ${this.symbol.name} uses the global DB ${target.name} directly; pass the data through the interface so the block stays reusable.`,
          );
        }
      }
    }
  }

  private text(r: Reference): string {
    return this.ctx.text(r.file, r.range.start, r.range.end).replace(/^"|"$/g, '');
  }

  // --- FOR counter through a reference --------------------------------------------------------

  private counterThroughReference(statements: readonly Statement[]): void {
    const aliases = new Map<string, string>();
    for (const s of allStatements(statements)) {
      if (s.kind !== 'assign' || s.value.kind !== 'call' || s.value.callee.kind !== 'name')
        continue;
      if (s.value.callee.name.text.toUpperCase() !== 'REF') continue;
      const ptr = this.ctx.rootReference(this.file, s.target);
      const arg = s.value.args[0]?.value;
      const target = arg ? this.ctx.rootReference(this.file, arg) : undefined;
      if (ptr && target) aliases.set(ptr.symbolId, target.symbolId);
    }
    if (aliases.size === 0) return;
    const walk = (list: readonly Statement[], counters: readonly string[]) => {
      for (const s of list) {
        if (s.kind === 'assign' && s.target.kind === 'deref') {
          const ptr = this.ctx.rootReference(this.file, s.target);
          const pointsTo = ptr ? aliases.get(ptr.symbolId) : undefined;
          if (pointsTo && counters.includes(pointsTo)) {
            this.add(
              'for-counter-modified',
              s.target.range,
              `This changes the FOR counter through the reference #${this.sectionOf.get(ptr!.symbolId)?.name ?? ''}; the loop may run a different number of times than written.`,
              'warning',
            );
          }
        }
        const counter =
          s.kind === 'for' ? this.ctx.rootReference(this.file, s.variable)?.symbolId : undefined;
        for (const child of childLists(s)) walk(child, counter ? [...counters, counter] : counters);
      }
    };
    walk(statements, []);
  }

  // --- Status values ---------------------------------------------------------------------------

  private statusNotEvaluated(statements: readonly Statement[]): void {
    this.statusOutputsNotEvaluated();
    const statusCalls = this.ba.calls.filter(
      (c) =>
        c.kind === 'instruction' &&
        this.ctx.project.profile.returnsStatus(c.instruction ?? c.calleeName),
    );
    if (statusCalls.length === 0) return;
    const at = new Map<number, Statement>();
    for (const s of allStatements(statements)) {
      if (s.kind === 'callStatement') at.set(s.call.range.start, s);
      if (s.kind === 'assign' && s.value.kind === 'call') at.set(s.value.range.start, s);
    }
    const analysis = this.ctx.analysis;
    for (const call of statusCalls) {
      const s = at.get(call.range.start);
      if (!s) continue;
      if (s.kind === 'callStatement') {
        this.add(
          'status-not-evaluated',
          call.range,
          `The status ${call.calleeName} returns is dropped; check it to notice when the instruction fails.`,
        );
        continue;
      }
      if (s.kind !== 'assign') continue;
      const target = this.ctx.rootReference(this.file, s.target);
      if (!target) continue;
      const refs = analysis.referencesBySymbol.get(target.symbolId) ?? [];
      const read = refs.some(
        (r) =>
          (r.access === 'read' || r.access === 'readwrite' || r.access === 'call') &&
          !(r.range.start >= s.range.start && r.range.end <= s.range.end),
      );
      if (!read) {
        this.add(
          'status-not-evaluated',
          s.range,
          `The status ${call.calleeName} returns is stored in #${this.sectionOf.get(target.symbolId)?.name ?? ''} but never checked; evaluate it to notice when the instruction fails.`,
        );
      }
    }
  }

  /** Status and error outputs of called FBs that are neither connected nor read afterwards. */
  private statusOutputsNotEvaluated(): void {
    const all = this.ctx.analysis.referencesBySymbol;
    for (const call of this.ba.calls) {
      if (call.kind !== 'fb' || !call.calleeId) continue;
      const callee = this.ctx.blockSymbol(call.calleeId);
      if (!callee || callee.incomplete) continue;
      const connected = new Set(
        call.args
          .filter((a) => a.direction === 'out' && a.parameter)
          .map((a) => a.parameter!.toLowerCase()),
      );
      for (const m of this.ctx.project.index.interfaceMembers(callee)) {
        if (
          m.section !== 'Output' ||
          !STATUS_OUTPUT.test(m.name) ||
          connected.has(m.name.toLowerCase())
        )
          continue;
        const readOutside = (all.get(m.id) ?? []).some(
          (r) => r.blockId !== callee.id && (r.access === 'read' || r.access === 'readwrite'),
        );
        if (readOutside) continue;
        this.add(
          'status-not-evaluated',
          call.range,
          `The output ${m.name} of ${callee.name} is never checked; connect it or read it from the instance to notice failures.`,
        );
      }
    }
  }

  // --- Statement shapes -------------------------------------------------------------------------

  private statementRules(statements: readonly Statement[]): void {
    for (const s of allStatements(statements)) {
      if (s.kind === 'case' && !s.elseBody) {
        this.add(
          'case-without-else',
          keywordRange(s, 4),
          'This CASE has no ELSE; values without a branch go unnoticed. Add an ELSE that handles them.',
        );
      }
      if (s.kind === 'region' && s.body.every((b) => b.kind === 'empty')) {
        this.add('empty-region', keywordRange(s, 6), `The REGION "${s.title}" is empty.`);
      }
      if (s.kind === 'while' || s.kind === 'repeat') this.loopExit(s);
      for (const e of statementExpressions(s)) this.expressionRules(e);
    }
    this.unreachable(statements);
    for (const network of this.symbol.block.networks) {
      for (const rung of network.ladder?.rungs ?? []) {
        for (const item of rung.items)
          if (item.kind === 'element') for (const a of item.args) this.expressionRules(a.value);
      }
    }
  }

  private expressionRules(e: Expression): void {
    for (const sub of subExpressions(e)) {
      if (sub.kind === 'binary' && (sub.op === '=' || sub.op === '<>')) {
        if (
          isReal(this.ctx.typeOf(this.file, sub.left)) ||
          isReal(this.ctx.typeOf(this.file, sub.right))
        ) {
          this.add(
            'real-compared-with-equal',
            sub.range,
            'Floating-point values are rarely exactly equal; compare with a tolerance (ABS(a - b) < limit) instead.',
          );
        }
      }
      if (sub.kind === 'address' && /^%[TC]\d/i.test(sub.text)) {
        this.add(
          'simatic-timer-counter',
          sub.range,
          `${sub.text} is a SIMATIC timer or counter; on S7-1200/1500 use IEC timers and counters (TON, CTU ...) as multi-instances.`,
        );
      }
      if (
        sub.kind === 'call' &&
        sub.callee.kind === 'name' &&
        SIMATIC_TIMER_INSTRUCTIONS.has(sub.callee.name.text.toUpperCase())
      ) {
        this.add(
          'simatic-timer-counter',
          sub.callee.range,
          `${sub.callee.name.text} is a SIMATIC timer or counter; on S7-1200/1500 use IEC timers and counters (TON, CTU ...) as multi-instances.`,
        );
      }
    }
  }

  private loopExit(s: Statement & { kind: 'while' | 'repeat' }): void {
    const body = [...allStatements(s.body)];
    if (body.some((b) => b.kind === 'exit' || b.kind === 'return' || b.kind === 'goto')) return;
    const c = s.condition;
    const constant = c.kind === 'literal' && c.literalKind === 'bool';
    const neverEnds =
      constant &&
      ((s.kind === 'while' && /^true$/i.test(c.text)) ||
        (s.kind === 'repeat' && /^false$/i.test(c.text)));
    if (constant && !neverEnds) return;
    if (!neverEnds) {
      if (
        body.some(
          (b) =>
            b.kind === 'callStatement' ||
            [...statementExpressions(b)].some((e) =>
              [...subExpressions(e)].some((x) => x.kind === 'call'),
            ),
        )
      )
        return;
      const conditionIds = new Set<string>();
      for (const sub of subExpressions(c)) {
        const r = this.ctx.rootReference(this.file, sub);
        if (r) conditionIds.add(r.symbolId);
      }
      if (conditionIds.size === 0) return;
      const start = s.body[0]?.range.start ?? s.range.start;
      const end = s.body[s.body.length - 1]?.range.end ?? s.range.end;
      const written = this.ba.references.some(
        (r) =>
          conditionIds.has(r.symbolId) &&
          (r.access === 'write' || r.access === 'readwrite') &&
          r.range.start >= start &&
          r.range.end <= end,
      );
      if (written) return;
    }
    const kw = s.kind === 'while' ? 'WHILE' : 'REPEAT';
    this.add(
      'loop-without-exit',
      keywordRange(s, kw.length),
      `Nothing in this ${kw} loop changes its condition and it has no EXIT; if it runs once it may never end and trip the cycle-time watchdog.`,
    );
  }

  private unreachable(list: readonly Statement[]): void {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      for (const child of childLists(s)) this.unreachable(child);
      if (s.kind !== 'exit' && s.kind !== 'continue' && s.kind !== 'return' && s.kind !== 'goto')
        continue;
      const next = list.slice(i + 1).find((x) => x.kind !== 'empty' && x.kind !== 'label');
      if (next && !list.slice(i + 1).some((x) => x.kind === 'label')) {
        this.add(
          'unreachable-code',
          next.range,
          'This code never runs: the statement before it always leaves.',
        );
      }
      break;
    }
  }

  // --- Complexity ------------------------------------------------------------------------------

  private complexity(statements: readonly Statement[]): void {
    const { cyclomatic, nesting: maxNesting } = measureComplexity(statements);
    const options = ruleOptions(this.config, 'complexity');
    const maxC = typeof options['maxCyclomatic'] === 'number' ? options['maxCyclomatic'] : 15;
    const maxN = typeof options['maxNesting'] === 'number' ? options['maxNesting'] : 4;
    const range = this.symbol.block.name.range;
    if (cyclomatic > maxC)
      this.add(
        'complexity',
        range,
        `${this.symbol.name} has a cyclomatic complexity of ${cyclomatic} (limit ${maxC}); split it into smaller blocks.`,
      );
    if (maxNesting > maxN)
      this.add(
        'complexity',
        range,
        `${this.symbol.name} nests control statements ${maxNesting} deep (limit ${maxN}); flatten the logic or move parts into their own blocks.`,
      );
  }

  // --- Temp holding state ------------------------------------------------------------------------

  private stateInTemp(): void {
    for (const m of this.members) {
      if (m.section !== 'Temp' || !m.declaration) continue;
      if ((m.type.kind === 'system' && m.type.type.kind === 'fb') || m.type.kind === 'fb') {
        this.add(
          'state-in-temp',
          m.declaration.range,
          `#${m.name} is an instance in Temp; Temp is rebuilt every call, so the instance loses its state (a timer never finishes, an edge is never seen). Declare it in Static.`,
        );
      }
    }
    for (const network of this.symbol.block.networks) {
      for (const rung of network.ladder?.rungs ?? []) {
        for (const item of rung.items) {
          if (item.kind !== 'element' || !EDGE_ELEMENTS.has(item.instruction.toUpperCase()))
            continue;
          const bit =
            item.args.find((a) => a.name?.text.toLowerCase() === 'bit') ??
            (item.instruction.toUpperCase().endsWith('TRIG') ? item.args[0] : undefined);
          const r = bit ? this.ctx.rootReference(this.file, bit.value) : undefined;
          const m = r ? this.sectionOf.get(r.symbolId) : undefined;
          if (m?.section === 'Temp') {
            this.add(
              'state-in-temp',
              bit!.value.range,
              `The edge memory #${m.name} is a Temp; it is lost between calls, so the edge is detected wrongly. Use a Static or global bit.`,
            );
          }
        }
      }
    }
  }

  // --- Unused variables (spec, "Unused variables") --------------------------------------------------

  private unusedVariables(): void {
    const all = this.ctx.analysis.referencesBySymbol;
    for (const m of this.members) {
      if (!m.declaration) continue;
      const refs = (all.get(m.id) ?? []).filter((r) => r.access !== 'declaration');
      const inBlock = refs.filter((r) => r.blockId === this.symbol.id);
      const name = `#${m.name}`;
      switch (m.section) {
        case 'Temp':
          if (refs.length === 0)
            this.add('unused-temp', m.declaration.range, `${name} is never used; remove it.`);
          break;
        case 'Static':
          if (refs.length === 0 && !hmiRelevant(m)) {
            this.add(
              'unused-static',
              m.declaration.range,
              `${name} is never used in the exported code; remove it unless an HMI or OPC UA client uses it.`,
            );
          }
          break;
        case 'Constant':
          if (refs.length === 0)
            this.add('unused-constant', m.declaration.range, `The constant ${name} is never used.`);
          break;
        case 'Input':
          if (
            !inBlock.some(
              (r) => r.access === 'read' || r.access === 'readwrite' || r.access === 'call',
            )
          ) {
            this.add(
              'unused-input',
              m.declaration.range,
              `The input ${name} is never read inside ${this.symbol.name}.`,
            );
          }
          break;
        case 'Output':
          if (!inBlock.some((r) => r.access === 'write' || r.access === 'readwrite')) {
            this.add(
              'unused-output',
              m.declaration.range,
              `The output ${name} is never written inside ${this.symbol.name}.`,
            );
          }
          break;
        case 'InOut':
          if (inBlock.length === 0)
            this.add(
              'unused-inout',
              m.declaration.range,
              `The InOut ${name} is never used inside ${this.symbol.name}.`,
            );
          break;
        default:
          break;
      }
    }
  }
}

/** Cyclomatic complexity (1 + branches + loops) and the deepest nesting of control statements. */
export function measureComplexity(statements: readonly Statement[]): {
  cyclomatic: number;
  nesting: number;
} {
  let cyclomatic = 1;
  let nesting = 0;
  const walk = (list: readonly Statement[], depth: number) => {
    for (const s of list) {
      let d = depth;
      if (s.kind === 'if') {
        cyclomatic += s.branches.length;
        d++;
      } else if (s.kind === 'case') {
        cyclomatic += s.clauses.length;
        d++;
      } else if (s.kind === 'for' || s.kind === 'while' || s.kind === 'repeat') {
        cyclomatic++;
        d++;
      }
      nesting = Math.max(nesting, d);
      for (const child of childLists(s)) walk(child, d);
    }
  };
  walk(statements, 0);
  return { cyclomatic, nesting };
}

/** A Static an HMI or OPC UA client is explicitly meant to use (setpoint, explicit access). */
function hmiRelevant(m: MemberInfo): boolean {
  for (const a of m.node?.attributes ?? []) {
    const n = a.name.toLowerCase();
    if (n === 's7_setpoint' && /^true$/i.test(a.value)) return true;
    if (
      (n === 'externalaccessible' || n === 'externalvisible' || n === 'externalwritable') &&
      /^true$/i.test(a.value)
    )
      return true;
    if (n === 's7_access' && /readonly|readwrite/i.test(a.value)) return true;
  }
  return false;
}

/** Instances of timers, counters and edge detectors inside an FB type, followed into multi-instances. */
export function timerInstancesOf(
  ctx: AnalyzerContext,
  fb: BlockSymbol,
  seen = new Set<string>(),
): string[] {
  if (seen.has(fb.id)) return [];
  seen.add(fb.id);
  const out: string[] = [];
  for (const m of ctx.project.index.interfaceMembers(fb)) {
    if (m.section !== 'Static') continue;
    if (
      m.type.kind === 'system' &&
      m.type.type.kind === 'fb' &&
      TIMER_INSTRUCTIONS.has((m.type.type.instruction ?? '').toUpperCase())
    )
      out.push(`#${m.name}`);
    else if (m.type.kind === 'fb') {
      const inner = ctx.blockSymbol(m.type.block.id);
      if (inner)
        out.push(...timerInstancesOf(ctx, inner, seen).map((x) => `#${m.name}.${x.slice(1)}`));
    }
  }
  return out;
}

export { membersOf };
