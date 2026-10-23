// Program graph view (spec, "Program graph (v1.x)"): a canvas for thousands of blocks (pan, zoom,
// only what is visible is drawn) plus an accessible list of the shown blocks.
import { clear, h } from '../shared/dom.ts';
import { button, toolbar, type Post } from '../tables-common/grid.ts';
import {
  filterGraph,
  layoutGraph,
  NODE_H,
  NODE_W,
  type Filters,
  type GraphEdge,
  type GraphModel,
  type PlacedNode,
} from './layout.ts';

export interface GraphView {
  update(model: GraphModel): void;
  /** For tests: what is laid out now. */
  placed(): readonly PlacedNode[];
}

const LIST_LIMIT = 500;

export function createGraphView(root: HTMLElement, post: Post): GraphView {
  const filters: Filters = { ob: '', unit: '', instances: false, search: '' };
  let model: GraphModel | undefined;
  let placed: PlacedNode[] = [];
  let edges: GraphEdge[] = [];
  let byId = new Map<string, PlacedNode>();
  let selected: string | undefined;
  const view = { x: 20, y: 20, scale: 1 };

  const plcSelect = h('select', { 'aria-label': 'PLC' });
  const obSelect = h('select', { 'aria-label': 'Show only what this OB calls' });
  const unitSelect = h('select', { 'aria-label': 'Software unit' });
  const instances = h('input', {
    type: 'checkbox',
    'aria-label': 'Show data blocks and instances',
  });
  const search = h('input', {
    type: 'search',
    placeholder: 'Find block',
    'aria-label': 'Find a block by name',
  });
  const status = h('span', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const canvas = h('canvas', {
    tabindex: '0',
    role: 'img',
    'aria-label':
      'Program graph. Arrow keys pan, plus and minus zoom, F fits, Enter opens the selected block.',
  });
  const list = h('ul', { class: 'graph-list', 'aria-label': 'Blocks shown in the graph' });
  const tooltip = h('div', { class: 'graph-tooltip', role: 'tooltip' });
  tooltip.hidden = true;

  clear(root);
  root.append(
    h('style', {}, STYLE),
    toolbar(
      plcSelect,
      h('label', {}, 'OB ', obSelect),
      h('label', {}, 'Unit ', unitSelect),
      h('label', {}, instances, ' data blocks'),
      search,
      button('−', 'Zoom out', () => zoom(1 / 1.25)),
      button('+', 'Zoom in', () => zoom(1.25)),
      button('Fit', 'Fit the graph into the view', fit),
      status,
    ),
    h(
      'div',
      { class: 'graph-body' },
      h('div', { class: 'graph-canvas' }, canvas, tooltip),
      h('nav', { class: 'graph-side' }, list),
    ),
  );

  plcSelect.addEventListener('change', () => post({ type: 'selectPlc', root: plcSelect.value }));
  for (const [el, apply] of [
    [obSelect, () => (filters.ob = obSelect.value)],
    [unitSelect, () => (filters.unit = unitSelect.value)],
    [instances, () => (filters.instances = instances.checked)],
  ] as const) {
    el.addEventListener('change', () => {
      apply();
      relayout(true);
    });
  }
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filters.search = search.value.trim();
      relayout(true);
    }, 200);
  });

  function options(select: HTMLSelectElement, items: [string, string][], value: string): void {
    clear(select);
    for (const [v, label] of items) select.append(h('option', { value: v }, label));
    select.value = items.some(([v]) => v === value) ? value : (items[0]?.[0] ?? '');
  }

  function relayout(refit: boolean): void {
    if (!model) return;
    const t0 = performance.now();
    const f = filterGraph(model, filters);
    placed = layoutGraph(f.nodes, f.edges);
    edges = f.edges;
    byId = new Map(placed.map((n) => [n.id, n]));
    status.textContent = `${placed.length} of ${model.nodes.length} blocks, ${edges.length} calls (${Math.round(performance.now() - t0)} ms)`;
    renderList();
    if (refit) fit();
    else draw();
  }

  function renderList(): void {
    clear(list);
    const sorted = [...placed]
      .sort((a, b) => a.layer - b.layer || a.order - b.order)
      .slice(0, LIST_LIMIT);
    for (const n of sorted) {
      const calls = edges.filter((e) => e.from === n.id).length;
      list.append(
        h(
          'li',
          {},
          h(
            'button',
            {
              class: `link ${n.id === selected ? 'selected' : ''}`,
              'aria-label': `${n.kind} ${n.name}${n.failsafe ? ', fail-safe' : ''}, calls ${calls}`,
              onClick: () => select(n.id, true),
              onDblclick: () => post({ type: 'open', path: n.path }),
            },
            `${n.kind} ${n.name}`,
          ),
        ),
      );
    }
    if (placed.length > LIST_LIMIT)
      list.append(
        h('li', { class: 'muted' }, `… ${placed.length - LIST_LIMIT} more; use the filters.`),
      );
  }

  function select(id: string, center: boolean): void {
    selected = id;
    const n = byId.get(id);
    if (n && center) {
      const r = canvas.getBoundingClientRect();
      view.x = r.width / 2 - (n.x + NODE_W / 2) * view.scale;
      view.y = r.height / 2 - (n.y + NODE_H / 2) * view.scale;
    }
    draw();
  }

  function fit(): void {
    const r = canvas.getBoundingClientRect();
    if (placed.length === 0 || r.width === 0) return draw();
    const maxX = Math.max(...placed.map((n) => n.x)) + NODE_W;
    const maxY = Math.max(...placed.map((n) => n.y)) + NODE_H;
    view.scale = Math.max(
      0.05,
      Math.min(1.5, Math.min((r.width - 40) / maxX, (r.height - 40) / maxY)),
    );
    view.x = 20;
    view.y = 20;
    draw();
  }

  function zoom(factor: number, cx?: number, cy?: number): void {
    const r = canvas.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    const next = Math.max(0.05, Math.min(3, view.scale * factor));
    view.x = px - ((px - view.x) * next) / view.scale;
    view.y = py - ((py - view.y) * next) / view.scale;
    view.scale = next;
    draw();
  }

  function color(name: string, fallback: string): string {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  }

  function draw(): void {
    const r = canvas.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(r.width * dpr));
    canvas.height = Math.max(1, Math.floor(r.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    const left = -view.x / view.scale;
    const top = -view.y / view.scale;
    const right = left + r.width / view.scale;
    const bottom = top + r.height / view.scale;
    const fg = color('--vscode-foreground', '#888');
    const visible = (n: PlacedNode) =>
      n.x + NODE_W >= left && n.x <= right && n.y + NODE_H >= top && n.y <= bottom;
    ctx.lineWidth = 1 / view.scale;
    for (const e of edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b || (!visible(a) && !visible(b))) continue;
      ctx.strokeStyle =
        e.from === selected || e.to === selected
          ? color('--vscode-focusBorder', '#09f')
          : withAlpha(fg, 0.35);
      ctx.setLineDash(e.conditional || e.kind !== 'call' ? [4 / view.scale, 3 / view.scale] : []);
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1 + 40, y1, x2 - 40, y2, x2, y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const fills: Record<string, string> = {
      OB: color('--vscode-charts-blue', '#3b82f6'),
      FB: color('--vscode-charts-green', '#22c55e'),
      FC: color('--vscode-charts-purple', '#a855f7'),
      DB: color('--vscode-charts-yellow', '#eab308'),
    };
    ctx.font = '12px sans-serif';
    ctx.textBaseline = 'middle';
    for (const n of placed) {
      if (!visible(n)) continue;
      ctx.fillStyle = withAlpha(fills[n.kind] ?? fg, 0.22);
      ctx.strokeStyle =
        n.id === selected
          ? color('--vscode-focusBorder', '#09f')
          : n.failsafe
            ? color('--vscode-editorWarning-foreground', '#e90')
            : (fills[n.kind] ?? fg);
      ctx.lineWidth = (n.id === selected || n.failsafe ? 2.5 : 1) / view.scale;
      ctx.beginPath();
      ctx.rect(n.x, n.y, NODE_W, NODE_H);
      ctx.fill();
      ctx.stroke();
      if (view.scale > 0.35) {
        ctx.fillStyle = fg;
        const label = `${n.kind} ${n.name}${n.failsafe ? ' (F)' : ''}`;
        ctx.fillText(
          label.length > 26 ? label.slice(0, 25) + '…' : label,
          n.x + 6,
          n.y + NODE_H / 2,
        );
      }
    }
    ctx.restore();
  }

  function nodeAt(clientX: number, clientY: number): PlacedNode | undefined {
    const r = canvas.getBoundingClientRect();
    const x = (clientX - r.left - view.x) / view.scale;
    const y = (clientY - r.top - view.y) / view.scale;
    return placed.find((n) => x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H);
  }

  let drag: { x: number; y: number; moved: boolean } | undefined;
  canvas.addEventListener(
    'mousedown',
    (e) => (drag = { x: e.clientX, y: e.clientY, moved: false }),
  );
  window.addEventListener('mouseup', (e) => {
    if (drag && !drag.moved) {
      const n = nodeAt(e.clientX, e.clientY);
      if (n) select(n.id, false);
    }
    drag = undefined;
  });
  canvas.addEventListener('mousemove', (e) => {
    if (drag) {
      view.x += e.clientX - drag.x;
      view.y += e.clientY - drag.y;
      drag.moved ||= Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2;
      drag.x = e.clientX;
      drag.y = e.clientY;
      draw();
      return;
    }
    const n = nodeAt(e.clientX, e.clientY);
    tooltip.hidden = !n;
    if (n) {
      const r = canvas.getBoundingClientRect();
      tooltip.textContent = `${n.kind} ${n.name}${n.unit ? ` · ${n.unit}` : ''}${n.obType ? ` · ${n.obType}${n.priority !== null ? `, priority ${n.priority}` : ''}` : ''}${n.failsafe ? ' · fail-safe' : ''} — double-click to open`;
      tooltip.style.left = `${e.clientX - r.left + 12}px`;
      tooltip.style.top = `${e.clientY - r.top + 12}px`;
    }
  });
  canvas.addEventListener('dblclick', (e) => {
    const n = nodeAt(e.clientX, e.clientY);
    if (n) post({ type: 'open', path: n.path });
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  });
  canvas.addEventListener('keydown', (e) => {
    const step = 60;
    if (e.key === 'ArrowLeft') view.x += step;
    else if (e.key === 'ArrowRight') view.x -= step;
    else if (e.key === 'ArrowUp') view.y += step;
    else if (e.key === 'ArrowDown') view.y -= step;
    else if (e.key === '+' || e.key === '=') return zoom(1.25);
    else if (e.key === '-') return zoom(1 / 1.25);
    else if (e.key === 'f' || e.key === 'F') return fit();
    else if (e.key === 'Enter' && selected)
      return post({ type: 'open', path: byId.get(selected)?.path ?? '' });
    else return;
    e.preventDefault();
    draw();
  });
  new ResizeObserver(() => draw()).observe(canvas);

  return {
    update(next: GraphModel) {
      const changedPlc = model?.plc !== next.plc;
      model = next;
      options(
        plcSelect,
        next.plcs.map((p) => [p.root, p.name]),
        next.plc,
      );
      const obs = next.nodes
        .filter((n) => n.kind === 'OB')
        .sort((a, b) => a.name.localeCompare(b.name));
      options(
        obSelect,
        [['', 'all OBs'], ...obs.map((o) => [o.id, o.name] as [string, string])],
        filters.ob,
      );
      filters.ob = obSelect.value;
      const units = [...new Set(next.nodes.map((n) => n.unit).filter((u) => u))].sort();
      options(
        unitSelect,
        [
          ['', 'all units'],
          ...(units.length ? [['(main program)', 'main program'] as [string, string]] : []),
          ...units.map((u) => [u, u] as [string, string]),
        ],
        filters.unit,
      );
      filters.unit = unitSelect.value;
      relayout(changedPlc);
    },
    placed: () => placed,
  };
}

function withAlpha(c: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const v = parseInt(m[1]!, 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

const STYLE = `
.graph-body { display: flex; height: calc(100vh - 44px); }
.graph-canvas { position: relative; flex: 1; min-width: 0; }
.graph-canvas canvas { width: 100%; height: 100%; display: block; cursor: grab; }
.graph-side { width: 240px; overflow: auto; border-left: 1px solid var(--vscode-panel-border, transparent); }
.graph-list { list-style: none; margin: 0; padding: 4px; }
.graph-list button.link { background: none; border: none; color: var(--vscode-textLink-foreground); text-align: left; padding: 1px 4px; width: 100%; }
.graph-list button.link.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.graph-tooltip { position: absolute; pointer-events: none; padding: 3px 6px; background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); }
`;
