// Filtering and layered layout of the program graph (no DOM, so it is testable and fast).
// Layers: longest path from the blocks nobody calls (OBs and dead blocks), back edges of cycles
// ignored; order within a layer: two barycenter sweeps. Linear in nodes and edges.

export interface GraphNode {
  id: string;
  name: string;
  kind: string;
  namespace: string;
  unit: string;
  failsafe: boolean;
  dbKind: string;
  path: string;
  obType: string;
  priority: number | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'call' | 'instance' | 'instanceOf';
  conditional: boolean;
  inLoop: boolean;
  count: number;
}

export interface GraphModel {
  view: 'graph';
  plcs: { root: string; name: string }[];
  plc: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Filters {
  /** Only what this OB reaches. */
  ob: string;
  unit: string;
  instances: boolean;
  search: string;
}

export interface PlacedNode extends GraphNode {
  layer: number;
  order: number;
  x: number;
  y: number;
}

export const NODE_W = 180;
export const NODE_H = 30;
export const GAP_X = 80;
export const GAP_Y = 14;

export function filterGraph(
  model: GraphModel,
  filters: Filters,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let nodes = model.nodes.filter((n) => n.kind !== 'UDT' && (filters.instances || n.kind !== 'DB'));
  let edges = model.edges.filter((e) => filters.instances || e.kind === 'call');
  if (filters.unit)
    nodes = nodes.filter(
      (n) => n.unit === filters.unit || (filters.unit === '(main program)' && !n.unit),
    );
  let keep = new Set(nodes.map((n) => n.id));
  if (filters.ob) {
    const out = adjacency(edges.filter((e) => keep.has(e.from) && keep.has(e.to)));
    const reached = new Set<string>([filters.ob]);
    const stack = [filters.ob];
    while (stack.length) {
      for (const next of out.get(stack.pop()!) ?? []) {
        if (reached.has(next)) continue;
        reached.add(next);
        stack.push(next);
      }
    }
    keep = new Set([...keep].filter((id) => reached.has(id)));
  }
  if (filters.search) {
    const s = filters.search.toLowerCase();
    const hits = new Set(nodes.filter((n) => n.name.toLowerCase().includes(s)).map((n) => n.id));
    // a hit and its direct neighbours
    for (const e of edges) {
      if (hits.has(e.from)) hits.add(e.to);
      else if (hits.has(e.to)) hits.add(e.from);
    }
    keep = new Set([...keep].filter((id) => hits.has(id)));
  }
  nodes = nodes.filter((n) => keep.has(n.id));
  edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { nodes, edges };
}

function adjacency(edges: readonly GraphEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.from);
    if (list) list.push(e.to);
    else out.set(e.from, [e.to]);
  }
  return out;
}

export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): PlacedNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out = adjacency(edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to));
  const incoming = new Map<string, number>();
  for (const [, targets] of out)
    for (const t of targets) incoming.set(t, (incoming.get(t) ?? 0) + 1);
  // OBs first, then blocks nobody calls, then whatever is left (cycles without entry)
  const byName = [...nodes].sort(
    (a, b) => (a.kind === 'OB' ? 0 : 1) - (b.kind === 'OB' ? 0 : 1) || a.name.localeCompare(b.name),
  );
  const roots = byName.filter((n) => !incoming.get(n.id));
  // iterative DFS: finishing order gives a topological order of the DAG without back edges
  const state = new Map<string, 1 | 2>();
  const finished: string[] = [];
  const forward = new Map<string, string[]>();
  const visit = (start: string) => {
    if (state.has(start)) return;
    const stack: [string, number][] = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const targets = out.get(top[0]) ?? [];
      if (top[1] < targets.length) {
        const next = targets[top[1]++]!;
        const s = state.get(next);
        if (s === undefined) {
          (forward.get(top[0]) ?? forward.set(top[0], []).get(top[0])!).push(next);
          state.set(next, 1);
          stack.push([next, 0]);
        } else if (s === 2) {
          (forward.get(top[0]) ?? forward.set(top[0], []).get(top[0])!).push(next);
        }
        // s === 1: back edge of a cycle, ignored for layering
      } else {
        state.set(top[0], 2);
        finished.push(top[0]);
        stack.pop();
      }
    }
  };
  for (const r of roots) visit(r.id);
  for (const n of byName) visit(n.id);
  const layer = new Map<string, number>();
  for (const id of [...finished].reverse()) {
    const l = layer.get(id) ?? 0;
    layer.set(id, l);
    for (const t of forward.get(id) ?? []) layer.set(t, Math.max(layer.get(t) ?? 0, l + 1));
  }
  // order within layers: start by name, then barycenter of the callers, twice
  const layers = new Map<number, GraphNode[]>();
  for (const n of byName) {
    const l = layer.get(n.id) ?? 0;
    (layers.get(l) ?? layers.set(l, []).get(l)!).push(n);
  }
  const order = new Map<string, number>();
  for (const list of layers.values()) list.forEach((n, i) => order.set(n.id, i));
  const callers = new Map<string, string[]>();
  for (const [from, targets] of forward)
    for (const t of targets) (callers.get(t) ?? callers.set(t, []).get(t)!).push(from);
  const levels = [...layers.keys()].sort((a, b) => a - b);
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const l of levels) {
      const list = layers.get(l)!;
      const score = (n: GraphNode) => {
        const c = callers.get(n.id);
        return c && c.length
          ? c.reduce((s, x) => s + (order.get(x) ?? 0), 0) / c.length
          : (order.get(n.id) ?? 0);
      };
      const scored = list.map((n) => [n, score(n)] as const).sort((a, b) => a[1] - b[1]);
      scored.forEach(([n], i) => order.set(n.id, i));
      layers.set(
        l,
        scored.map(([n]) => n),
      );
    }
  }
  return nodes.map((n) => {
    const l = layer.get(n.id) ?? 0;
    const o = order.get(n.id) ?? 0;
    return { ...n, layer: l, order: o, x: l * (NODE_W + GAP_X), y: o * (NODE_H + GAP_Y) };
  });
}

/** A generated program for performance tests: OBs calling FBs and FCs in a tree with some cycles. */
export function syntheticGraph(blocks: number): GraphModel {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const obs = Math.max(1, Math.floor(blocks / 500));
  for (let i = 0; i < blocks; i++) {
    const kind = i < obs ? 'OB' : i % 3 === 0 ? 'FC' : 'FB';
    nodes.push({
      id: `b${i}`,
      name: `${kind}_${i}`,
      kind,
      namespace: '',
      unit: i % 4 === 0 ? 'Unit_A' : '',
      failsafe: false,
      dbKind: '',
      path: `/p/${kind}_${i}.s7dcl`,
      obType: kind === 'OB' ? 'ProgramCycle' : '',
      priority: kind === 'OB' ? 1 : null,
    });
    if (i >= obs) {
      const parent = Math.floor((i - obs) / 3);
      edges.push({
        from: `b${parent}`,
        to: `b${i}`,
        kind: 'call',
        conditional: i % 5 === 0,
        inLoop: false,
        count: 1,
      });
      if (i % 97 === 0)
        edges.push({
          from: `b${i}`,
          to: `b${Math.max(obs, i - 50)}`,
          kind: 'call',
          conditional: false,
          inLoop: false,
          count: 1,
        });
    }
  }
  return { view: 'graph', plcs: [{ root: '/p', name: 'Synthetic' }], plc: '/p', nodes, edges };
}
