// A LAD/FBD network as a series-parallel tree. Rungs in .s7dcl are paths between named wires
// (wire#powerrail, wire#w1 ...): a rung starts at the power rail, at a wire or at an operand
// (FBD), passes through elements, may name the point it reached (`wire#w1` inside the rung) and
// may end at a wire (`END_RUNG wire#w1`). Joining those paths gives a graph; reducing it gives
// the series/parallel structure the drawing needs. Graphs that do not reduce are not drawn.
import type { Expression, LadderBody, LadderElement, Rung } from '../syntax/ast.ts';

export type LadderTree =
  | {
      readonly kind: 'element';
      readonly element: LadderElement;
      readonly rung: number;
      readonly item: number;
    }
  | { readonly kind: 'series'; readonly items: readonly LadderTree[] }
  /** `open`: the branches do not join again on the right (they end at coils). */
  | { readonly kind: 'parallel'; readonly items: readonly LadderTree[]; readonly open: boolean };

export type RungSource =
  | { readonly kind: 'powerrail' }
  | { readonly kind: 'operand'; readonly operand: Expression; readonly negated: boolean }
  | { readonly kind: 'none' };

export interface LadderComponent {
  readonly source: RungSource;
  readonly tree: LadderTree;
}

const EMPTY: LadderTree = { kind: 'series', items: [] };

interface Edge {
  from: number;
  to: number;
  tree: LadderTree;
  order: number;
}

class UnionFind {
  private readonly parent: number[] = [];
  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }
  union(a: number, b: number): number {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
    return ra;
  }
}

function series(a: LadderTree, b: LadderTree): LadderTree {
  const items = [
    ...(a.kind === 'series' ? a.items : [a]),
    ...(b.kind === 'series' ? b.items : [b]),
  ];
  return items.length === 1 ? items[0]! : { kind: 'series', items };
}

function parallel(trees: LadderTree[], open: boolean): LadderTree {
  const items: LadderTree[] = [];
  for (const t of trees) {
    if (t.kind === 'parallel' && t.open === open) items.push(...t.items);
    else items.push(t);
  }
  return { kind: 'parallel', items, open };
}

/**
 * The drawable structure of a network, one component per independent rung group; undefined when
 * the rungs do not form a series-parallel structure.
 */
export function ladderComponents(body: LadderBody): LadderComponent[] | undefined {
  const uf = new UnionFind();
  const wires = new Map<string, number>();
  const wire = (name: string) => {
    const key = name.toLowerCase();
    let n = wires.get(key);
    if (n === undefined) {
      n = uf.add();
      wires.set(key, n);
    }
    return n;
  };
  const sources = new Map<number, RungSource>();
  const edges: Edge[] = [];
  let order = 0;

  body.rungs.forEach((rung: Rung, rungIndex) => {
    let current: number;
    switch (rung.start.kind) {
      case 'powerrail': {
        current = wire('powerrail');
        sources.set(current, { kind: 'powerrail' });
        break;
      }
      case 'wire':
        current = wire(rung.start.name);
        break;
      case 'operand': {
        current = uf.add();
        const op = rung.start.operand;
        const negated = op.kind === 'unary' && op.op === 'NOT';
        sources.set(current, { kind: 'operand', operand: negated ? op.operand : op, negated });
        break;
      }
      case 'none':
        current = uf.add();
        sources.set(current, { kind: 'none' });
        break;
    }
    rung.items.forEach((item, itemIndex) => {
      if (item.kind === 'junction') {
        current = uf.union(current, wire(item.name));
        return;
      }
      const next = uf.add();
      edges.push({
        from: current,
        to: next,
        tree: { kind: 'element', element: item, rung: rungIndex, item: itemIndex },
        order: order++,
      });
      current = next;
    });
    if (rung.end) uf.union(current, wire(rung.end.name));
  });

  // canonical node ids
  const canonicalSources = new Map<number, RungSource>();
  for (const [n, s] of sources) canonicalSources.set(uf.find(n), s);
  for (const e of edges) {
    e.from = uf.find(e.from);
    e.to = uf.find(e.to);
  }
  if (edges.some((e) => e.from === e.to)) return undefined;

  // connected components (ignoring direction)
  const nodes = new Set<number>([...canonicalSources.keys()]);
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
  }
  const neighbours = new Map<number, number[]>();
  for (const n of nodes) neighbours.set(n, []);
  for (const e of edges) {
    neighbours.get(e.from)!.push(e.to);
    neighbours.get(e.to)!.push(e.from);
  }
  const componentOf = new Map<number, number>();
  let componentCount = 0;
  const orderedNodes = [...nodes].sort((a, b) => firstOrder(a) - firstOrder(b));
  function firstOrder(n: number): number {
    let min = Number.MAX_SAFE_INTEGER;
    for (const e of edges) if (e.from === n || e.to === n) min = Math.min(min, e.order);
    return min;
  }
  for (const start of orderedNodes) {
    if (componentOf.has(start)) continue;
    const id = componentCount++;
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (componentOf.has(n)) continue;
      componentOf.set(n, id);
      stack.push(...neighbours.get(n)!);
    }
  }

  const components: LadderComponent[] = [];
  let virtualId = Math.max(-1, ...nodes) + 1;
  for (let c = 0; c < componentCount; c++) {
    const compNodes = [...nodes].filter((n) => componentOf.get(n) === c);
    const compEdges = edges.filter((e) => componentOf.get(e.from) === c).map((e) => ({ ...e }));
    if (compEdges.length === 0) continue;
    const incoming = new Map<number, number>();
    const outgoing = new Map<number, number>();
    for (const e of compEdges) {
      incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
      outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + 1);
    }
    const roots = compNodes.filter((n) => !incoming.get(n));
    if (roots.length !== 1) return undefined;
    const root = roots[0]!;
    const source = canonicalSources.get(root) ?? { kind: 'none' as const };
    const end = virtualId++;
    for (const n of compNodes) {
      if (!outgoing.get(n) && n !== root)
        compEdges.push({ from: n, to: end, tree: EMPTY, order: Number.MAX_SAFE_INTEGER });
    }
    const tree = reduce(compEdges, root, end);
    if (!tree) return undefined;
    components.push({ source, tree });
  }
  return components;
}

/** Series and parallel reduction of a two-terminal graph; undefined if it does not reduce. */
function reduce(edges: Edge[], root: number, end: number): LadderTree | undefined {
  let list = edges;
  for (let guard = 0; guard < 10_000; guard++) {
    if (list.length === 1 && list[0]!.from === root && list[0]!.to === end) return list[0]!.tree;
    let changed = false;
    // parallel: several edges between the same two nodes
    const groups = new Map<string, Edge[]>();
    for (const e of list) {
      const key = `${e.from}>${e.to}`;
      const g = groups.get(key);
      if (g) g.push(e);
      else groups.set(key, [e]);
    }
    if ([...groups.values()].some((g) => g.length > 1)) {
      list = [...groups.values()].map((g) => {
        if (g.length === 1) return g[0]!;
        const sorted = [...g].sort((a, b) => a.order - b.order);
        const trees = sorted
          .map((e) => e.tree)
          .filter((t) => !(t.kind === 'series' && t.items.length === 0));
        const hasWire = trees.length < sorted.length;
        // a branch that is only a wire (bypass) is kept as an empty branch
        const items = hasWire ? [...trees, EMPTY] : trees;
        return {
          from: g[0]!.from,
          to: g[0]!.to,
          tree: items.length === 1 ? items[0]! : parallel(items, g[0]!.to === end),
          order: sorted[0]!.order,
        };
      });
      changed = true;
    }
    // series: a node with exactly one edge in and one edge out
    const inCount = new Map<number, Edge[]>();
    const outCount = new Map<number, Edge[]>();
    for (const e of list) {
      (inCount.get(e.to) ?? inCount.set(e.to, []).get(e.to)!).push(e);
      (outCount.get(e.from) ?? outCount.set(e.from, []).get(e.from)!).push(e);
    }
    for (const [node, ins] of inCount) {
      if (node === end || node === root) continue;
      const outs = outCount.get(node);
      if (ins.length !== 1 || !outs || outs.length !== 1) continue;
      const a = ins[0]!;
      const b = outs[0]!;
      if (a === b) continue;
      list = list.filter((e) => e !== a && e !== b);
      list.push({
        from: a.from,
        to: b.to,
        tree: series(a.tree, b.tree),
        order: Math.min(a.order, b.order),
      });
      changed = true;
      break;
    }
    if (!changed) return undefined;
  }
  return undefined;
}

/** Every element of a tree, left to right, top to bottom. */
export function treeElements(tree: LadderTree): Extract<LadderTree, { kind: 'element' }>[] {
  if (tree.kind === 'element') return [tree];
  return tree.items.flatMap(treeElements);
}
