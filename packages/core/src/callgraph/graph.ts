// The program's call graph (spec, "Call graph and cross-block analysis"; ADR 0011): every OB is a
// root; edges record how each call happens; every block knows which OBs reach it, with their
// priority and cycle time, and whether it runs on every call of that OB.
import { analyzeProject, type ProjectAnalysis } from '../check/analysis.ts';
import type { CallSite } from '../check/binder.ts';
import type { ObInfo } from '../model/manifest.ts';
import type { BlockSymbol, Project } from '../model/project.ts';

export interface CallEdge {
  readonly call: CallSite;
  /** Calling block id. */
  readonly from: string;
  /** Called FB or FC id; undefined for system instructions and unresolved calls. */
  readonly to: string | undefined;
  /** Not executed on every run of the caller (IF/CASE branch, LAD/FBD EN). */
  readonly conditional: boolean;
  readonly inLoop: boolean;
}

export interface ObReach {
  readonly ob: BlockSymbol;
  readonly info: ObInfo | undefined;
  /** Reached on every call of the OB through unconditional calls. */
  readonly everyInvocation: boolean;
  /** Some call on the way sits in a loop. */
  readonly inLoop: boolean;
  /** The first condition on the way, when not every invocation. */
  readonly condition: string | undefined;
}

export interface ExecutionContext {
  readonly blockId: string;
  readonly reachedFrom: readonly ObReach[];
  /** Runs on every call of at least one OB that reaches it. */
  readonly everyCycle: boolean;
}

export interface CallGraph {
  readonly revision: number;
  readonly blocks: ReadonlyMap<string, BlockSymbol>;
  readonly outgoing: ReadonlyMap<string, readonly CallEdge[]>;
  readonly incoming: ReadonlyMap<string, readonly CallEdge[]>;
  readonly roots: readonly BlockSymbol[];
  /** Calls the files cannot settle (VARIANT, DB_ANY, instances passed as parameters ...). */
  readonly unresolved: readonly CallEdge[];
  /** Blocks referenced but missing from the export, by name. */
  readonly missing: ReadonlyMap<string, readonly CallEdge[]>;
  readonly contexts: ReadonlyMap<string, ExecutionContext>;
}

const cache = new WeakMap<Project, CallGraph>();

/** Effective OB data: program-cycle and startup OBs have priority 1 when nothing says otherwise. */
export function obData(project: Project, ob: BlockSymbol): ObInfo | undefined {
  const info = project.index.obInfo(ob);
  if (!info) return undefined;
  if (info.priority === undefined && (info.type === 'ProgramCycle' || info.type === 'Startup'))
    return { ...info, priority: 1 };
  return info;
}

/** `analysis`: pass it from inside an analysis pass (the project's analysis is not cached yet). */
export function callGraph(project: Project, analysis?: ProjectAnalysis): CallGraph {
  const cached = cache.get(project);
  if (cached && cached.revision === project.revision) return cached;
  analysis ??= analyzeProject(project);
  const blocks = new Map<string, BlockSymbol>();
  for (const b of analysis.blocks.values()) blocks.set(b.symbol.id, b.symbol);
  const outgoing = new Map<string, CallEdge[]>();
  const incoming = new Map<string, CallEdge[]>();
  const unresolved: CallEdge[] = [];
  const missing = new Map<string, CallEdge[]>();
  for (const call of analysis.calls) {
    const target = call.calleeId?.startsWith('block:') ? blocks.get(call.calleeId) : undefined;
    const edge: CallEdge = {
      call,
      from: call.callerId,
      to: target && (target.kind === 'FB' || target.kind === 'FC') ? target.id : undefined,
      conditional: call.conditional,
      inLoop: call.inLoop,
    };
    push(outgoing, edge.from, edge);
    if (edge.to) push(incoming, edge.to, edge);
    if (call.kind === 'unresolved') {
      unresolved.push(edge);
      if (call.calleeName && !call.instance) push(missing, call.calleeName, edge);
    }
  }
  const roots = [...blocks.values()]
    .filter((b) => b.kind === 'OB')
    .sort((a, b) => a.name.localeCompare(b.name));
  const reach = new Map<string, Map<string, ObReach>>();
  for (const ob of roots) {
    const info = obData(project, ob);
    const visited = new Set<string>();
    const visit = (
      blockId: string,
      every: boolean,
      loop: boolean,
      condition: string | undefined,
    ) => {
      const key = `${blockId}|${every}|${loop}`;
      if (visited.has(key)) return;
      visited.add(key);
      const perOb = reach.get(blockId) ?? new Map<string, ObReach>();
      reach.set(blockId, perOb);
      const old = perOb.get(ob.id);
      if (
        !old ||
        (every && !old.everyInvocation) ||
        (!loop && old.inLoop && every === old.everyInvocation)
      ) {
        perOb.set(ob.id, {
          ob,
          info,
          everyInvocation: every || (old?.everyInvocation ?? false),
          inLoop: loop && (old?.inLoop ?? true),
          condition: every ? undefined : (condition ?? old?.condition),
        });
      }
      for (const edge of outgoing.get(blockId) ?? []) {
        if (!edge.to) continue;
        const cond = edge.conditional
          ? edge.call.conditions[edge.call.conditions.length - 1]
          : undefined;
        visit(edge.to, every && !edge.conditional, loop || edge.inLoop, condition ?? cond);
      }
    };
    visit(ob.id, true, false, undefined);
  }
  const contexts = new Map<string, ExecutionContext>();
  for (const [blockId, perOb] of reach) {
    const reachedFrom = [...perOb.values()].sort((a, b) => a.ob.name.localeCompare(b.ob.name));
    contexts.set(blockId, {
      blockId,
      reachedFrom,
      everyCycle: reachedFrom.some((r) => r.everyInvocation),
    });
  }
  const graph: CallGraph = {
    revision: project.revision,
    blocks,
    outgoing,
    incoming,
    roots,
    unresolved,
    missing,
    contexts,
  };
  cache.set(project, graph);
  return graph;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Where a block runs: the OBs that reach it, their priority and cycle, every cycle or not. */
export function executionContext(project: Project, blockId: string): ExecutionContext | undefined {
  return callGraph(project).contexts.get(blockId);
}

/** "OB_Cyclic100ms (OB35, 100 ms)" */
function obLabel(r: ObReach): string {
  const parts: string[] = [];
  if (r.info?.number !== undefined) parts.push(`OB${r.info.number}`);
  if (r.info?.type === 'CyclicInterrupt' && r.info.cycleTimeMs !== undefined)
    parts.push(`${r.info.cycleTimeMs} ms`);
  return parts.length > 0 ? `${r.ob.name} (${parts.join(', ')})` : r.ob.name;
}

/** Short summary for hovers and CodeLens, e.g. "OB_Main (OB1) every cycle; OB_Cyclic (OB35, 100 ms) conditional". */
export function calledFrom(project: Project, blockId: string): string {
  const graph = callGraph(project);
  if (graph.blocks.get(blockId)?.kind === 'OB')
    return 'organization block (called by the operating system)';
  const ctx = graph.contexts.get(blockId);
  if (!ctx || ctx.reachedFrom.length === 0)
    return graph.roots.length === 0 ? 'no OB in the export' : 'not reached from any OB';
  return ctx.reachedFrom
    .map(
      (r) =>
        `${obLabel(r)} ${r.everyInvocation ? 'every cycle' : 'conditional'}${r.inLoop ? ' (in a loop)' : ''}`,
    )
    .join('; ');
}

export interface CallTreeNode {
  readonly name: string;
  readonly kind: 'ob' | 'fb' | 'fc' | 'instruction' | 'unresolved';
  /** Block id for blocks. */
  readonly blockId: string | undefined;
  /** Instance used by an FB call (#Inst or "IDB"). */
  readonly instance: string | undefined;
  readonly conditional: boolean;
  readonly condition: string | undefined;
  readonly inLoop: boolean;
  readonly viaEn: boolean;
  /** Where the call (or the OB) is. */
  readonly file: string;
  readonly start: number;
  readonly end: number;
  /** Shown instead of children when the block is already on the path. */
  readonly recursive: boolean;
  readonly children: readonly CallTreeNode[];
}

/** OB → blocks tree for the sidebar, with every-cycle, conditional and loop markers. */
export function callTree(
  project: Project,
  options: { instructions?: boolean } = {},
): CallTreeNode[] {
  const graph = callGraph(project);
  const build = (blockId: string, path: readonly string[], depth: number): CallTreeNode[] => {
    const out: CallTreeNode[] = [];
    for (const edge of graph.outgoing.get(blockId) ?? []) {
      const c = edge.call;
      const target = edge.to ? graph.blocks.get(edge.to) : undefined;
      if (!target && c.kind === 'instruction' && !options.instructions && !c.instance) continue;
      const recursive = edge.to !== undefined && path.includes(edge.to);
      out.push({
        name: target?.name ?? c.calleeName,
        kind: target
          ? target.kind === 'FB'
            ? 'fb'
            : 'fc'
          : c.kind === 'instruction'
            ? 'instruction'
            : 'unresolved',
        blockId: target?.id,
        instance: c.instance?.name,
        conditional: edge.conditional,
        condition: edge.conditional ? c.conditions[c.conditions.length - 1] : undefined,
        inLoop: edge.inLoop,
        viaEn: c.viaEn,
        file: c.file,
        start: c.range.start,
        end: c.range.end,
        recursive,
        children:
          target && !recursive && depth < 32
            ? build(target.id, [...path, target.id], depth + 1)
            : [],
      });
    }
    return out;
  };
  return graph.roots.map((ob) => ({
    name: ob.name,
    kind: 'ob' as const,
    blockId: ob.id,
    instance: undefined,
    conditional: false,
    condition: undefined,
    inLoop: false,
    viaEn: false,
    file: ob.file.path,
    start: ob.block.name.range.start,
    end: ob.block.name.range.end,
    recursive: false,
    children: build(ob.id, [ob.id], 0),
  }));
}

/** Calls into a block (call hierarchy, incoming). */
export function callersOf(project: Project, blockId: string): readonly CallEdge[] {
  return callGraph(project).incoming.get(blockId) ?? [];
}

/** Calls a block makes (call hierarchy, outgoing). */
export function calleesOf(project: Project, blockId: string): readonly CallEdge[] {
  return callGraph(project).outgoing.get(blockId) ?? [];
}
