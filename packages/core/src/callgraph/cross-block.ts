// Cross-block rules (spec, "Cross-block rules"): bugs whose cause lies in another block than the
// symptom. Warnings, except recursion, a policy error (ADR 0013). Unresolved calls and partial
// exports never produce errors (ADR 0011).
import type { Reference } from '../check/binder.ts';
import type { AnalyzerContext } from '../analyzer/context.ts';
import { allStatements } from '../analyzer/context.ts';
import {
  blockStatements,
  timerInstancesOf,
  type BlockFacts,
  type Finding,
} from '../analyzer/single-block.ts';
import type { BlockSymbol } from '../model/project.ts';
import type { CallEdge, CallGraph } from './graph.ts';
import { obData } from './graph.ts';

/** Instructions that make an access consistent across priorities. */
const CONSISTENCY = new Set(['DIS_AIRT', 'EN_AIRT', 'UMOVE_BLK', 'UFILL_BLK']);

export function crossBlockFindings(
  ctx: AnalyzerContext,
  graph: CallGraph,
  facts: ReadonlyMap<string, BlockFacts>,
): Finding[] {
  const findings: Finding[] = [];
  const add = (f: Finding) => {
    if (
      !findings.some(
        (x) => x.rule === f.rule && x.file === f.file && x.range.start === f.range.start,
      )
    )
      findings.push(f);
  };
  conditionalTimerBlocks(ctx, graph, add);
  sharedInstances(ctx, graph, add);
  globalData(ctx, graph, add);
  inOutAliasing(ctx, graph, add);
  unreliableFcOutputs(ctx, graph, facts, add);
  recursion(graph, add);
  deadBlocks(graph, add);
  unresolved(graph, add);
  return findings;
}

type Add = (f: Finding) => void;

/** A timer, counter or edge detector inside an FB stops updating when the FB is called conditionally (C26m). */
function conditionalTimerBlocks(ctx: AnalyzerContext, graph: CallGraph, add: Add): void {
  for (const edges of graph.outgoing.values()) {
    for (const edge of edges) {
      if (!edge.to || (!edge.conditional && !edge.inLoop)) continue;
      const fb = graph.blocks.get(edge.to);
      if (fb?.kind !== 'FB') continue;
      const timers = timerInstancesOf(ctx, fb);
      if (timers.length === 0) continue;
      const last = edge.call.conditions[edge.call.conditions.length - 1];
      const how = edge.inLoop
        ? 'inside a loop'
        : last === 'EN'
          ? 'only when its EN input is true'
          : `only when ${last ?? 'a condition holds'}`;
      add({
        rule: 'timer-fb-called-conditionally',
        file: edge.call.file,
        range: edge.call.range,
        message: `${fb.name} is called ${how}, but it contains ${timers.join(', ')}; while the call is skipped these stop timing, counting or seeing edges.`,
      });
    }
  }
}

/** OBs (with priority) that run a block: itself when it is an OB. */
function obsOf(
  graph: CallGraph,
  blockId: string,
): { id: string; name: string; priority: number | undefined }[] {
  const block = graph.blocks.get(blockId);
  if (block?.kind === 'OB')
    return [{ id: block.id, name: block.name, priority: priorityOf(graph, block) }];
  return (graph.contexts.get(blockId)?.reachedFrom ?? []).map((r) => ({
    id: r.ob.id,
    name: r.ob.name,
    priority: r.info?.priority ?? undefined,
  }));
}

const priorityCache = new WeakMap<BlockSymbol, number | undefined>();

function priorityOf(graph: CallGraph, ob: BlockSymbol): number | undefined {
  if (!priorityCache.has(ob)) {
    const reach = graph.contexts.get(ob.id)?.reachedFrom.find((r) => r.ob.id === ob.id);
    priorityCache.set(ob, reach?.info?.priority);
  }
  return priorityCache.get(ob);
}

/** The same instance DB called from several blocks or OBs (C26l). */
function sharedInstances(ctx: AnalyzerContext, graph: CallGraph, add: Add): void {
  const byInstance = new Map<string, CallEdge[]>();
  for (const edges of graph.outgoing.values()) {
    for (const edge of edges) {
      const inst = edge.call.instance;
      if (!inst || inst.kind !== 'single') continue;
      byInstance.set(inst.id, [...(byInstance.get(inst.id) ?? []), edge]);
    }
  }
  for (const edges of byInstance.values()) {
    const callers = new Set(edges.map((e) => e.from));
    if (callers.size < 2) continue;
    const obs = new Map<string, { name: string; priority: number | undefined }>();
    for (const e of edges) for (const ob of obsOf(graph, e.from)) obs.set(ob.id, ob);
    const priorities = new Set([...obs.values()].map((o) => o.priority ?? 'unknown'));
    const name = edges[0]!.call.instance!.name;
    if (obs.size >= 2 && (priorities.size > 1 || priorities.has('unknown'))) {
      const list = [...obs.values()]
        .map((o) => (o.priority !== undefined ? `${o.name} (priority ${o.priority})` : o.name))
        .join(', ');
      for (const e of edges) {
        add({
          rule: 'instance-shared-by-two-obs',
          file: e.call.file,
          range: e.call.range,
          message: `The instance ${name} is used from ${list}; an interrupt can run it while the other call is half-way through, mixing both states.`,
        });
      }
      continue;
    }
    const sorted = [...edges].sort(
      (a, b) => a.call.file.localeCompare(b.call.file) || a.call.range.start - b.call.range.start,
    );
    const firstCaller = sorted[0]!.from;
    for (const e of sorted.filter((x) => x.from !== firstCaller)) {
      const first = graph.blocks.get(firstCaller)?.name ?? '';
      add({
        rule: 'instance-called-twice',
        file: e.call.file,
        range: e.call.range,
        message: `The instance ${name} is also called in ${first}; one instance called from two places mixes the state of both calls.`,
      });
    }
  }
  void ctx;
}

/** Block id that owns a member id: member:db_x/a/b → block:db_x */
function ownerBlockId(memberId: string): string {
  return 'block:' + memberId.slice('member:'.length).split('/')[0];
}

/** Global data: several writers, and data shared across priorities without protection. */
function globalData(ctx: AnalyzerContext, graph: CallGraph, add: Add): void {
  const analysis = ctx.analysis;
  const protectedBlocks = new Set<string>();
  for (const edges of graph.outgoing.values()) {
    for (const e of edges)
      if (CONSISTENCY.has((e.call.instruction ?? e.call.calleeName).toUpperCase()))
        protectedBlocks.add(e.from);
  }
  for (const [symbolId, refs] of analysis.referencesBySymbol) {
    let ownerDb: BlockSymbol | undefined;
    if (symbolId.startsWith('member:')) {
      ownerDb = graph.blocks.get(ownerBlockId(symbolId));
      if (ownerDb?.kind !== 'DB' || ownerDb.dbKind !== 'global') continue;
    } else if (!symbolId.startsWith('tag:')) {
      continue;
    }
    const uses = refs.filter(
      (r) =>
        r.access !== 'declaration' &&
        r.access !== 'type' &&
        r.blockId !== ownerDb?.id &&
        r.blockId !== '',
    );
    const writes = uses.filter((r) => r.access === 'write' || r.access === 'readwrite');
    const reads = uses.filter((r) => r.access === 'read' || r.access === 'readwrite');
    // several writers
    const writers = [...new Set(writes.map((w) => w.blockId))].sort();
    if (writers.length > 1) {
      const first = graph.blocks.get(writers[0]!)?.name ?? '';
      for (const w of writes.filter((x) => x.blockId !== writers[0])) {
        add({
          rule: 'multiple-writers',
          file: w.file,
          range: w.range,
          message: `${label(ctx, w)} is also written by ${first}; with several writers the last one in the cycle wins.`,
        });
      }
    }
    // read in a higher-priority OB than it is written in
    for (const r of reads) {
      if (protectedBlocks.has(r.blockId)) continue;
      const readPrios = obsOf(graph, r.blockId)
        .map((o) => o.priority)
        .filter((p): p is number => p !== undefined);
      for (const w of writes) {
        if (w.blockId === r.blockId || protectedBlocks.has(w.blockId)) continue;
        const writer = obsOf(graph, w.blockId).filter((o) => o.priority !== undefined);
        const lower = writer.find((o) => readPrios.some((p) => p > o.priority!));
        if (lower) {
          add({
            rule: 'unprotected-cross-priority-data',
            file: r.file,
            range: r.range,
            message: `${label(ctx, r)} is written in ${lower.name} and read here at a higher priority; the interrupt can see it half-updated. Protect the access (DIS_AIRT/EN_AIRT, UMOVE_BLK) or copy it consistently.`,
          });
          break;
        }
      }
    }
  }
}

function label(ctx: AnalyzerContext, r: Reference): string {
  return ctx.text(r.file, r.range.start, r.range.end);
}

/** The same variable passed to two InOut parameters of one call. */
function inOutAliasing(ctx: AnalyzerContext, graph: CallGraph, add: Add): void {
  for (const edges of graph.outgoing.values()) {
    for (const edge of edges) {
      if (!edge.to) continue;
      const callee = graph.blocks.get(edge.to)!;
      const inOuts = new Set(
        ctx.project.index
          .interfaceMembers(callee)
          .filter((m) => m.section === 'InOut')
          .map((m) => m.name.toLowerCase()),
      );
      if (inOuts.size < 2) continue;
      const seen = new Map<string, string>();
      for (const a of edge.call.args) {
        if (!a.parameter || !inOuts.has(a.parameter.toLowerCase())) continue;
        const text = ctx
          .text(edge.call.file, a.value.range.start, a.value.range.end)
          .replace(/\s+/g, '')
          .toLowerCase();
        const other = seen.get(text);
        if (other) {
          add({
            rule: 'inout-aliasing',
            file: edge.call.file,
            range: a.value.range,
            message: `The same variable is passed to the InOut parameters ${other} and ${a.parameter} of ${callee.name}; writes through one change the other.`,
          });
        } else {
          seen.set(text, a.parameter);
        }
      }
    }
  }
}

/** A caller uses an FC output that the FC does not write on every path. */
function unreliableFcOutputs(
  ctx: AnalyzerContext,
  graph: CallGraph,
  facts: ReadonlyMap<string, BlockFacts>,
  add: Add,
): void {
  for (const edges of graph.outgoing.values()) {
    for (const edge of edges) {
      if (!edge.to) continue;
      const missing = facts.get(edge.to)?.outputsNotAlwaysWritten;
      if (!missing || missing.size === 0) continue;
      const callee = graph.blocks.get(edge.to)!;
      for (const a of edge.call.args) {
        if (a.direction === 'out' && a.parameter && missing.has(a.parameter)) {
          add({
            rule: 'unreliable-fc-output',
            file: edge.call.file,
            range: a.value.range,
            message: `${callee.name} does not write ${a.parameter} on every path, so this variable may receive an undefined value.`,
          });
        }
      }
      if (missing.has('#return') && !isCallStatement(ctx, graph, edge)) {
        add({
          rule: 'unreliable-fc-output',
          file: edge.call.file,
          range: edge.call.range,
          message: `${callee.name} does not set its return value on every path, so the result used here may be undefined.`,
        });
      }
    }
  }
}

function isCallStatement(ctx: AnalyzerContext, graph: CallGraph, edge: CallEdge): boolean {
  const caller = graph.blocks.get(edge.from);
  if (!caller) return true;
  for (const s of allStatements(blockStatements(caller))) {
    if (s.kind === 'callStatement' && s.call.range.start === edge.call.range.start) return true;
  }
  // LAD/FBD box calls are statements too
  return (
    caller.block.networks.some(
      (n) =>
        n.ladder !== undefined &&
        edge.call.range.start >= n.range.start &&
        edge.call.range.end <= n.range.end,
    ) || !ctx
  );
}

/** Blocks that call themselves, directly or through others: a policy error (ADR 0013). */
function recursion(graph: CallGraph, add: Add): void {
  // Tarjan's strongly connected components over block-to-block edges
  let index = 0;
  const indexes = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const strong = (v: string) => {
    indexes.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const e of graph.outgoing.get(v) ?? []) {
      if (!e.to) continue;
      if (!indexes.has(e.to)) {
        strong(e.to);
        low.set(v, Math.min(low.get(v)!, low.get(e.to)!));
      } else if (onStack.has(e.to)) {
        low.set(v, Math.min(low.get(v)!, indexes.get(e.to)!));
      }
    }
    if (low.get(v) === indexes.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  };
  for (const id of graph.blocks.keys()) if (!indexes.has(id)) strong(id);
  for (const component of components) {
    const members = new Set(component);
    for (const id of component) {
      for (const e of graph.outgoing.get(id) ?? []) {
        if (!e.to || !members.has(e.to)) continue;
        if (component.length === 1 && e.to !== id) continue;
        const from = graph.blocks.get(id)!.name;
        const to = graph.blocks.get(e.to)!.name;
        add({
          rule: 'recursion',
          file: e.call.file,
          range: e.call.range,
          severity: 'error',
          message:
            e.to === id
              ? `${from} calls itself. PLC Studio does not allow recursion (ADR 0013), even though TIA compiles it: it risks a stack overflow and is hard to follow.`
              : `${from} calls ${to}, which leads back to ${from}. PLC Studio does not allow recursion (ADR 0013).`,
        });
      }
    }
  }
}

/** FBs and FCs no OB reaches (C26k). Only when the export contains OBs at all. */
function deadBlocks(graph: CallGraph, add: Add): void {
  if (graph.roots.length === 0) return;
  // fail-safe blocks without callers are run by an F-runtime group, whose F-OB is usually not
  // exportable (know-how protected): treat them as roots
  const fReached = new Set<string>();
  const queue = [...graph.blocks.values()]
    .filter((b) => b.failsafe && (graph.incoming.get(b.id) ?? []).length === 0)
    .map((b) => b.id);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (fReached.has(id)) continue;
    fReached.add(id);
    for (const e of graph.outgoing.get(id) ?? []) if (e.to) queue.push(e.to);
  }
  for (const b of graph.blocks.values()) {
    if (b.kind !== 'FB' && b.kind !== 'FC') continue;
    if (graph.contexts.has(b.id) || fReached.has(b.id)) continue;
    add({
      rule: 'dead-block',
      file: b.file.path,
      range: b.block.name.range,
      message: `No OB reaches ${b.name}; it never runs. Remove it, or call it (it may be called from a block that is not in the export).`,
    });
  }
}

/** Calls the files cannot settle: shown as info, never more. */
function unresolved(graph: CallGraph, add: Add): void {
  for (const e of graph.unresolved) {
    if (!e.call.instance) continue; // missing blocks are reported by the checker
    add({
      rule: 'unresolved-call',
      file: e.call.file,
      range: e.call.range,
      message: `The block called through ${e.call.instance.name} cannot be determined from the exported files; analyses that need it are skipped.`,
    });
  }
}

export { obData };
