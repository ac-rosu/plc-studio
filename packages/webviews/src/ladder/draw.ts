// Draws one laid-out network as SVG. Own visual design in VS Code's theme colors (light, dark and
// high contrast); no Siemens icons.
import type { ElementView, NetworkLayout, TextSpan } from '@plcstudio/core';
import { svg } from '../shared/dom.ts';

export interface DrawOptions {
  readonly scale: number;
  /** Severity per element id, from the diagnostics. */
  readonly severity: ReadonlyMap<string, 'error' | 'warning' | 'info'>;
  readonly messages: ReadonlyMap<string, string>;
  readonly selected: string | undefined;
}

function text(
  x: number,
  y: number,
  value: string,
  cls: string,
  anchor: 'start' | 'middle' | 'end' = 'middle',
  span?: TextSpan,
): SVGTextElement {
  const t = svg('text', { x, y, class: cls, 'text-anchor': anchor });
  t.textContent = value;
  if (span) {
    t.setAttribute('data-start', String(span.start));
    t.setAttribute('data-end', String(span.end));
    t.classList.add('operand');
  }
  return t;
}

function line(x1: number, y1: number, x2: number, y2: number, cls = 'wire'): SVGLineElement {
  return svg('line', { x1, y1, x2, y2, class: cls });
}

function leadIns(e: ElementView, g: SVGGElement): void {
  if (e.bodyX > e.x) g.append(line(e.x, e.lineY, e.bodyX, e.lineY));
  const right = e.bodyX + e.bodyW;
  if (right < e.x + e.w) g.append(line(right, e.lineY, e.x + e.w, e.lineY));
}

function contact(e: ElementView, g: SVGGElement): void {
  leadIns(e, g);
  const x1 = e.bodyX + 6;
  const x2 = e.bodyX + e.bodyW - 6;
  g.append(line(e.bodyX, e.lineY, x1, e.lineY), line(x2, e.lineY, e.bodyX + e.bodyW, e.lineY));
  g.append(
    line(x1, e.lineY - 12, x1, e.lineY + 12, 'symbol'),
    line(x2, e.lineY - 12, x2, e.lineY + 12, 'symbol'),
  );
  if (e.symbol === '/') g.append(line(x1 + 3, e.lineY + 9, x2 - 3, e.lineY - 9, 'symbol'));
  else if (e.symbol) g.append(text(e.bodyX + e.bodyW / 2, e.lineY + 4, e.symbol, 'mark'));
}

function coil(e: ElementView, g: SVGGElement, mark: string): void {
  leadIns(e, g);
  const cx = e.bodyX + e.bodyW / 2;
  const r = 12;
  g.append(
    svg('path', {
      d: `M ${cx - 5} ${e.lineY - r} A ${r} ${r} 0 0 0 ${cx - 5} ${e.lineY + r}`,
      class: 'symbol',
    }),
  );
  g.append(
    svg('path', {
      d: `M ${cx + 5} ${e.lineY - r} A ${r} ${r} 0 0 1 ${cx + 5} ${e.lineY + r}`,
      class: 'symbol',
    }),
  );
  g.append(
    line(e.bodyX, e.lineY, cx - 9, e.lineY),
    line(cx + 9, e.lineY, e.bodyX + e.bodyW, e.lineY),
  );
  if (mark === '/') g.append(line(cx - 4, e.lineY + 8, cx + 4, e.lineY - 8, 'symbol'));
  else if (mark) g.append(text(cx, e.lineY + 4, mark, 'mark'));
}

function compare(e: ElementView, g: SVGGElement): void {
  leadIns(e, g);
  const x1 = e.bodyX;
  const x2 = e.bodyX + e.bodyW;
  g.append(
    line(x1, e.lineY - 14, x1, e.lineY + 14, 'symbol'),
    line(x2, e.lineY - 14, x2, e.lineY + 14, 'symbol'),
  );
  g.append(text(x1 + e.bodyW / 2, e.lineY + 4, e.symbol, 'mark'));
  if (e.title) g.append(text(x1 + e.bodyW / 2, e.lineY + 26, e.title, 'type'));
}

function jump(e: ElementView, g: SVGGElement): void {
  leadIns(e, g);
  g.append(
    svg('rect', { x: e.bodyX, y: e.lineY - 10, width: e.bodyW, height: 20, rx: 10, class: 'body' }),
  );
  g.append(text(e.bodyX + e.bodyW / 2, e.lineY + 4, e.symbol, 'mark'));
}

function assign(e: ElementView, g: SVGGElement): void {
  leadIns(e, g);
  g.append(svg('rect', { x: e.bodyX, y: e.lineY - 12, width: e.bodyW, height: 24, class: 'body' }));
  g.append(text(e.bodyX + e.bodyW / 2, e.lineY + 4, e.symbol, 'mark'));
}

function box(e: ElementView, g: SVGGElement): void {
  const top = e.lineY - 22;
  const rows = Math.max(
    e.pins.filter((p) => p.side === 'in').length,
    e.pins.filter((p) => p.side === 'out').length,
  );
  const bottom = e.lineY + 18 * (rows - 1) + 12;
  g.append(
    svg('rect', { x: e.bodyX, y: top, width: e.bodyW, height: bottom - top, class: 'body box' }),
  );
  g.append(text(e.bodyX + e.bodyW / 2, top + 13, e.title, 'title'));
  for (const p of e.pins) {
    if (p.side === 'in') {
      const start = p.wired ? e.x : e.bodyX - 10;
      g.append(line(start, p.y, e.bodyX - (p.negated ? 6 : 0), p.y));
      if (p.negated) g.append(svg('circle', { cx: e.bodyX - 3, cy: p.y, r: 3, class: 'negation' }));
      g.append(text(e.bodyX + 4, p.y + 4, p.name, 'pin', 'start'));
      if (p.operand)
        g.append(text(e.bodyX - 12, p.y - 3, p.operand.text, 'value', 'end', p.operand));
      else if (p.missing) {
        const t = text(e.bodyX - 12, p.y - 3, '???', 'value missing', 'end');
        t.setAttribute('data-pin', p.name);
        g.append(t);
      }
    } else {
      const end = p.wired ? e.x + e.w : e.bodyX + e.bodyW + 10;
      g.append(line(e.bodyX + e.bodyW, p.y, end, p.y));
      g.append(text(e.bodyX + e.bodyW - 4, p.y + 4, p.name, 'pin', 'end'));
      if (p.operand)
        g.append(
          text(e.bodyX + e.bodyW + 12, p.y - 3, p.operand.text, 'value', 'start', p.operand),
        );
    }
  }
}

export function drawElement(e: ElementView, o: DrawOptions): SVGGElement {
  const g = svg('g', {
    class: `el shape-${e.shape}${o.selected === e.id ? ' selected' : ''}${o.severity.get(e.id) ? ` diag-${o.severity.get(e.id)}` : ''}${e.known ? '' : ' unknown'}`,
    'data-id': e.id,
    role: 'button',
    tabindex: o.selected === e.id ? 0 : -1,
    'aria-label': e.label + (o.messages.get(e.id) ? `. ${o.messages.get(e.id)}` : ''),
  });
  // hit area
  g.append(svg('rect', { x: e.x, y: e.y, width: e.w, height: e.h, class: 'hit' }));
  switch (e.shape) {
    case 'contact':
      contact(e, g);
      break;
    case 'coil':
      coil(e, g, e.symbol);
      break;
    case 'compare':
      compare(e, g);
      break;
    case 'jump':
      jump(e, g);
      break;
    case 'assign':
      assign(e, g);
      break;
    default:
      box(e, g);
  }
  if (e.instance)
    g.append(
      text(
        e.bodyX + e.bodyW / 2,
        e.lineY - 28,
        e.instance.text,
        'value instance',
        'middle',
        e.instance,
      ),
    );
  if (e.operand) {
    const above =
      e.shape === 'box' || e.shape === 'gate'
        ? e.lineY - 28
        : e.shape === 'compare'
          ? e.lineY - 18
          : e.lineY - 17;
    g.append(text(e.bodyX + e.bodyW / 2, above, e.operand.text, 'value', 'middle', e.operand));
  }
  if (e.operand2)
    g.append(
      text(
        e.bodyX + e.bodyW / 2,
        e.shape === 'compare' ? e.lineY + 40 : e.lineY + 30,
        e.operand2.text,
        'value',
        'middle',
        e.operand2,
      ),
    );
  const message = o.messages.get(e.id);
  if (message) {
    const title = svg('title');
    title.textContent = message;
    g.append(title);
  }
  return g;
}

export function drawNetwork(layout: NetworkLayout, o: DrawOptions): SVGSVGElement {
  const root = svg('svg', {
    width: Math.ceil(layout.width * o.scale),
    height: Math.ceil(layout.height * o.scale),
    viewBox: `0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}`,
    class: 'network-drawing',
    role: 'group',
  });
  for (const r of layout.rails) root.append(line(r.x1 + 1.5, r.y1, r.x2 + 1.5, r.y2, 'rail'));
  for (const w of layout.wires) root.append(line(w.x1, w.y1, w.x2, w.y2));
  for (const s of layout.starts) {
    if (s.kind !== 'operand' || !s.operand) continue;
    root.append(
      text(s.x, s.y - 4, (s.negated ? 'NOT ' : '') + s.operand.text, 'value', 'start', s.operand),
    );
  }
  for (const e of layout.elements) root.append(drawElement(e, o));
  return root;
}
