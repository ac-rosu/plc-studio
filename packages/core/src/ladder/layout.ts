// Grid layout of a LAD/FBD network (spec, "LAD/FBD viewer"): power rail on the left, elements
// in series left to right, parallel branches stacked, boxes with inputs on the left and outputs
// on the right. The result has absolute coordinates; the view only draws it.
import type { LadderElement as ProfileElement, ProfileIndex } from '@plcstudio/profiles';
import type { Argument, Expression, LadderBody, LadderElement } from '../syntax/ast.ts';
import { ladderComponents, type LadderTree, type RungSource } from './graph.ts';

export type ElementShape = 'contact' | 'coil' | 'box' | 'compare' | 'jump' | 'gate' | 'assign';

export interface TextSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface PinView {
  readonly name: string;
  readonly side: 'in' | 'out';
  /** Operand written at the pin; undefined when the rung feeds it or nothing is connected. */
  readonly operand: TextSpan | undefined;
  /** Absolute y of the pin. */
  readonly y: number;
  readonly negated: boolean;
  /** The rung line enters (inputs) or leaves (outputs) here. */
  readonly wired: boolean;
  /** A required input with nothing connected. */
  readonly missing: boolean;
}

export interface ElementView {
  /** network:rung:item, stable for one version of the text. */
  readonly id: string;
  readonly rung: number;
  readonly item: number;
  readonly shape: ElementShape;
  readonly instruction: string;
  /** Short mark drawn in contacts and coils: '/', 'P', 'S' ... */
  readonly symbol: string;
  readonly title: string;
  readonly instance: TextSpan | undefined;
  readonly negated: boolean;
  /** Contacts, coils, jumps, flip-flop and edge bits. */
  readonly operand: TextSpan | undefined;
  /** Edge memory bit of P/N contacts and coils; second input of a comparator. */
  readonly operand2: TextSpan | undefined;
  readonly template: string | undefined;
  readonly pins: readonly PinView[];
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Absolute y of the rung line through the element. */
  readonly lineY: number;
  /** x where the drawing of the element itself starts and ends (boxes leave room for operands). */
  readonly bodyX: number;
  readonly bodyW: number;
  readonly range: { readonly start: number; readonly end: number };
  /** Text for screen readers. */
  readonly label: string;
  /** The element is in the version profile (otherwise it is a call or an unknown box). */
  readonly known: boolean;
}

export interface WireView {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface StartView {
  readonly kind: RungSource['kind'];
  readonly operand: TextSpan | undefined;
  readonly negated: boolean;
  readonly x: number;
  readonly y: number;
}

export interface NetworkLayout {
  readonly width: number;
  readonly height: number;
  readonly elements: readonly ElementView[];
  readonly wires: readonly WireView[];
  /** The power rail: one vertical line. */
  readonly rails: readonly WireView[];
  readonly starts: readonly StartView[];
}

export interface LayoutOptions {
  readonly profile: ProfileIndex;
  readonly language: 'LAD' | 'FBD';
  /** Network number, used in element ids. */
  readonly network: number;
  /** Source text, to show operands as written. */
  readonly text: string;
  /** Title of a call box (the FB of a multi-instance call); default: the name as written. */
  readonly describeCall?: (element: LadderElement) => { title: string } | undefined;
}

/** Layout constants (px). */
export const LADDER_METRICS = {
  /** Offset of the rung line from the top of a cell. */
  line: 44,
  /** Approximate width of one character of operand text. */
  char: 7,
  minCell: 90,
  pinRow: 18,
  branchPad: 14,
  railX: 0,
  rootX: 24,
};

const M = LADDER_METRICS;

const textWidth = (s: string | undefined) => (s ? s.length * M.char : 0);

const CONTACT_LABELS: Record<string, string> = {
  CONTACT: 'Normally open contact',
  I_CONTACT: 'Normally closed contact',
  P_CONTACT: 'Contact for a rising edge',
  N_CONTACT: 'Contact for a falling edge',
  COIL: 'Coil',
  I_COIL: 'Negated coil',
  S_COIL: 'Set coil',
  R_COIL: 'Reset coil',
  P_COIL: 'Coil for a rising edge',
  N_COIL: 'Coil for a falling edge',
};

const SYMBOLS: Record<string, string> = {
  CONTACT: '',
  I_CONTACT: '/',
  P_CONTACT: 'P',
  N_CONTACT: 'N',
  COIL: '',
  I_COIL: '/',
  S_COIL: 'S',
  R_COIL: 'R',
  P_COIL: 'P',
  N_COIL: 'N',
  EQ_CONTACT: '==',
  NE_CONTACT: '<>',
  GT_CONTACT: '>',
  GE_CONTACT: '>=',
  LT_CONTACT: '<',
  LE_CONTACT: '<=',
};

const GATE_SYMBOLS: Record<string, string> = { A: '&', O: '>=1', X: 'X' };

function span(text: string, e: Expression | undefined): TextSpan | undefined {
  if (!e) return undefined;
  return { text: text.slice(e.range.start, e.range.end), start: e.range.start, end: e.range.end };
}

function argNamed(args: readonly Argument[], name: string): Argument | undefined {
  return args.find((a) => a.name?.text.toLowerCase() === name.toLowerCase());
}

interface Sized {
  readonly w: number;
  readonly h: number;
  readonly build: (x: number, y: number) => ElementView;
}

function sizeElement(el: LadderElement, rung: number, item: number, o: LayoutOptions): Sized {
  const upper = el.instruction.toUpperCase();
  const profileElement =
    el.callee.kind === 'name' ? o.profile.ladderElement(el.instruction) : undefined;
  const id = `${o.network}:${rung}:${item}`;
  const range = { start: el.range.start, end: el.range.end };
  const template = el.templates[0]?.value;
  const firstPositional = el.args.find((a) => a.direction === 'positional');

  // Contacts and coils (LAD), comparators
  if (
    profileElement &&
    (profileElement.shape === 'contact' || profileElement.shape === 'coil') &&
    !(o.language === 'FBD' && profileElement.shape === 'coil')
  ) {
    const operand = span(o.text, (argNamed(el.args, 'operand') ?? firstPositional)?.value);
    const operand2 = span(o.text, argNamed(el.args, 'bit')?.value);
    const w = Math.max(M.minCell, textWidth(operand?.text) + 20, textWidth(operand2?.text) + 20);
    const h = operand2 ? 82 : 66;
    return {
      w,
      h,
      build: (x, y) => ({
        id,
        rung,
        item,
        shape: profileElement.shape === 'contact' ? 'contact' : 'coil',
        instruction: el.instruction,
        symbol: SYMBOLS[upper] ?? profileElement.symbol ?? '',
        title: '',
        instance: undefined,
        negated: el.negated,
        operand,
        operand2,
        template,
        pins: [],
        x,
        y,
        w,
        h,
        lineY: y + M.line,
        bodyX: x + w / 2 - 14,
        bodyW: 28,
        range,
        label:
          `${CONTACT_LABELS[upper] ?? el.instruction} ${operand?.text ?? ''}${operand2 ? `, memory bit ${operand2.text}` : ''}`.trim(),
        known: true,
      }),
    };
  }
  if (/^(EQ|NE|GT|GE|LT|LE)_CONTACT$/.test(upper) && o.language === 'LAD') {
    const in1 = span(o.text, argNamed(el.args, 'in1')?.value);
    const in2 = span(o.text, argNamed(el.args, 'in2')?.value);
    const typeName = template?.replace(/^\s*\w+\s*:=\s*/, '');
    const w = Math.max(M.minCell + 10, textWidth(in1?.text) + 20, textWidth(in2?.text) + 20);
    const h = 86;
    return {
      w,
      h,
      build: (x, y) => ({
        id,
        rung,
        item,
        shape: 'compare',
        instruction: el.instruction,
        symbol: SYMBOLS[upper] ?? '?',
        title: typeName ?? '',
        instance: undefined,
        negated: el.negated,
        operand: in1,
        operand2: in2,
        template,
        pins: [],
        x,
        y,
        w,
        h,
        lineY: y + M.line,
        bodyX: x + w / 2 - 18,
        bodyW: 36,
        range,
        label: `Comparison ${SYMBOLS[upper] ?? ''} ${in1?.text ?? '?'} with ${in2?.text ?? '?'}${typeName ? ` as ${typeName}` : ''}`,
        known: !!profileElement,
      }),
    };
  }
  // Jumps
  if (profileElement?.shape === 'jump') {
    const label = span(o.text, firstPositional?.value ?? el.args[0]?.value);
    const w = Math.max(M.minCell, textWidth(label?.text) + 24);
    return {
      w,
      h: 66,
      build: (x, y) => ({
        id,
        rung,
        item,
        shape: 'jump',
        instruction: el.instruction,
        symbol: el.negated ? 'JMPN' : 'JMP',
        title: '',
        instance: undefined,
        negated: el.negated,
        operand: label,
        operand2: undefined,
        template,
        pins: [],
        x,
        y,
        w,
        h: 66,
        lineY: y + M.line,
        bodyX: x + w / 2 - 22,
        bodyW: 44,
        range,
        label: `${el.negated ? 'Jump if not' : 'Jump'} to label ${label?.text ?? '?'}`,
        known: true,
      }),
    };
  }
  // FBD assignment, set and reset boxes
  if (profileElement?.shape === 'coil' && o.language === 'FBD') {
    const operand = span(o.text, (argNamed(el.args, 'operand') ?? firstPositional)?.value);
    const symbol = upper === 'S_COIL' ? 'S' : upper === 'R_COIL' ? 'R' : '=';
    const w = Math.max(M.minCell, textWidth(operand?.text) + 20);
    return {
      w,
      h: 70,
      build: (x, y) => ({
        id,
        rung,
        item,
        shape: 'assign',
        instruction: el.instruction,
        symbol,
        title: symbol,
        instance: undefined,
        negated: el.negated,
        operand,
        operand2: undefined,
        template,
        pins: [],
        x,
        y,
        w,
        h: 70,
        lineY: y + M.line,
        bodyX: x + w / 2 - 20,
        bodyW: 40,
        range,
        label:
          `${symbol === '=' ? 'Assignment' : symbol === 'S' ? 'Set' : 'Reset'} ${operand?.text ?? ''}`.trim(),
        known: true,
      }),
    };
  }
  // Boxes: profile boxes, FBD gates, flip-flops, edge boxes, block and timer calls
  return sizeBox(el, rung, item, o, profileElement, id, range, template);
}

function sizeBox(
  el: LadderElement,
  rung: number,
  item: number,
  o: LayoutOptions,
  profileElement: ProfileElement | undefined,
  id: string,
  range: { start: number; end: number },
  template: string | undefined,
): Sized {
  const upper = el.instruction.toUpperCase();
  const gate = o.language === 'FBD' && profileElement && GATE_SYMBOLS[upper] !== undefined;
  // system FB boxes written as #Instance.TON(...) take TON's parameters; they are not block calls
  const systemInstruction =
    el.callee.kind === 'member' ? o.profile.instruction(el.callee.member.text) : undefined;
  const isCall = !profileElement && !systemInstruction;
  // the instance of a call: #Inst(...) or #Inst.TON(...)
  let instance: TextSpan | undefined;
  let title = profileElement?.symbol ?? el.instruction;
  if (el.callee.kind === 'member') {
    instance = span(o.text, el.callee.object);
    title = el.callee.member.text;
  } else if (el.callee.kind === 'local') {
    instance = span(o.text, el.callee);
    title = o.describeCall?.(el)?.title ?? el.instruction;
  } else if (isCall) {
    title = o.describeCall?.(el)?.title ?? el.instruction;
  }
  if (gate) title = GATE_SYMBOLS[upper]!;
  // the bit operand of flip-flops and edge boxes is shown above the box
  const bitBox = upper === 'S_SR' || upper === 'S_RS' || upper === 'P_TRIG' || upper === 'N_TRIG';
  const bitArg = bitBox
    ? (argNamed(el.args, 'operand') ??
      argNamed(el.args, 'bit') ??
      el.args.find((a) => a.direction === 'positional'))
    : undefined;
  const operand = bitBox ? span(o.text, bitArg?.value) : undefined;
  if (upper === 'S_SR') title = 'SR';
  if (upper === 'S_RS') title = 'RS';
  if (upper === 'P_TRIG') title = 'P_TRIG';
  if (upper === 'N_TRIG') title = 'N_TRIG';
  if (template && !isCall && !gate) title = `${title} ${template.replace(/^\s*\w+\s*:=\s*/, '')}`;

  // pins
  const ins: { name: string; operand: TextSpan | undefined; negated: boolean; missing: boolean }[] =
    [];
  const outs: { name: string; operand: TextSpan | undefined }[] = [];
  const params = profileElement?.parameters ?? systemInstruction?.parameters ?? [];
  // block calls are known boxes; only an unknown bare instruction name is not
  const known = !!profileElement || !!systemInstruction || el.callee.kind !== 'name';
  const given = new Set<Argument>();
  const usedAsOperand = new Set<Argument>(bitArg ? [bitArg] : []);
  // the input the rung feeds: the first Bool input that is not written (TON: IN, A: in1), else EN
  const fedInput = params.find(
    (p) =>
      p.direction === 'in' &&
      p.type === 'Bool' &&
      !argNamed(el.args, p.name) &&
      p.name !== 'operand' &&
      p.name !== 'bit',
  )?.name;
  const wiredIn =
    upper === 'S_SR'
      ? 'S'
      : upper === 'S_RS'
        ? 'R'
        : upper === 'P_TRIG' || upper === 'N_TRIG'
          ? 'CLK'
          : (fedInput ?? 'EN');
  ins.push({
    name: wiredIn.toUpperCase(),
    operand: undefined,
    negated: el.negated,
    missing: false,
  });
  for (const p of params) {
    if (p.direction === 'out' || p.name === fedInput || p.name === 'operand' || p.name === 'bit')
      continue;
    const a = argNamed(el.args, p.name);
    if (a) given.add(a);
    ins.push({
      name: p.name.toUpperCase(),
      operand: span(o.text, a?.value),
      negated: false,
      missing: !a && !p.optional && p.direction === 'in',
    });
  }
  for (const a of el.args) {
    if (given.has(a) || usedAsOperand.has(a)) continue;
    if (a.direction === 'out') {
      outs.push({ name: a.name?.text ?? '', operand: span(o.text, a.value) });
    } else if (
      !params.some(
        (p) => p.name.toLowerCase() === a.name?.text.toLowerCase() && p.direction === 'out',
      )
    ) {
      ins.push({
        name: a.name?.text ?? '',
        operand: span(o.text, a.value),
        negated: false,
        missing: false,
      });
    }
  }
  for (const p of params) {
    if (p.direction !== 'out') continue;
    const a = argNamed(el.args, p.name);
    if (a) {
      const i = outs.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase());
      if (i < 0) outs.push({ name: p.name, operand: span(o.text, a.value) });
    }
  }
  // profile pins are shown in capitals, pins of block calls as declared
  if (known) {
    for (const p of ins) p.name = p.name.toUpperCase();
    for (const p of outs) p.name = p.name.toUpperCase();
  }
  // the output that continues the rung: Q of timers and flip-flops, OUT of gates, else ENO
  const wiredOut = gate
    ? 'OUT'
    : (params
        .find(
          (p) =>
            p.direction === 'out' &&
            !argNamed(el.args, p.name) &&
            p.name.toUpperCase() !== 'ENO' &&
            p.type === 'Bool',
        )
        ?.name.toUpperCase() ??
      (upper === 'S_SR' || upper === 'S_RS' || upper === 'P_TRIG' || upper === 'N_TRIG'
        ? 'Q'
        : 'ENO'));
  outs.unshift({ name: wiredOut, operand: undefined });

  const rows = Math.max(ins.length, outs.length);
  const leftText = Math.max(0, ...ins.map((p) => textWidth(p.operand?.text)));
  const rightText = Math.max(0, ...outs.map((p) => textWidth(p.operand?.text)));
  const leftMargin = Math.max(18, leftText + 12);
  const rightMargin = Math.max(18, rightText + 12);
  const bodyW = Math.max(
    gate ? 46 : 80,
    textWidth(title) + 20,
    Math.max(...ins.map((p) => textWidth(p.name))) +
      Math.max(...outs.map((p) => textWidth(p.name))) +
      24,
  );
  const w = leftMargin + bodyW + rightMargin;
  const h = M.line + M.pinRow * (rows - 1) + 22;
  const describe = isCall
    ? `Call of ${title}${instance ? ` with instance ${instance.text}` : ''}`
    : gate
      ? `${upper === 'A' ? 'AND' : upper === 'O' ? 'OR' : 'XOR'} box${el.negated ? ' with negated first input' : ''}`
      : `Box ${title}${operand ? ` on ${operand.text}` : ''}${instance ? ` with instance ${instance.text}` : ''}`;
  return {
    w,
    h,
    build: (x, y) => {
      const lineY = y + M.line;
      const pins: PinView[] = [
        ...ins.map((p, i) => ({
          name: p.name,
          side: 'in' as const,
          operand: p.operand,
          y: lineY + i * M.pinRow,
          negated: p.negated,
          wired: i === 0,
          missing: p.missing,
        })),
        ...outs.map((p, i) => ({
          name: p.name,
          side: 'out' as const,
          operand: p.operand,
          y: lineY + i * M.pinRow,
          negated: false,
          wired: i === 0,
          missing: false,
        })),
      ];
      const inputs = ins
        .slice(1)
        .map((p) => `${p.name} ${p.operand?.text ?? (p.missing ? 'not connected' : 'open')}`);
      const outputs = outs.slice(1).map((p) => `${p.name} to ${p.operand?.text ?? 'nothing'}`);
      return {
        id,
        rung,
        item,
        shape: gate ? 'gate' : 'box',
        instruction: el.instruction,
        symbol: '',
        title,
        instance,
        negated: el.negated,
        operand,
        operand2: undefined,
        template,
        pins,
        x,
        y,
        w,
        h,
        lineY,
        bodyX: x + leftMargin,
        bodyW,
        range,
        label: [
          describe,
          inputs.length ? `inputs ${inputs.join(', ')}` : '',
          outputs.length ? `outputs ${outputs.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; '),
        known,
      };
    },
  };
}

interface Placed {
  readonly w: number;
  readonly h: number;
}

/** Lays out a ladder body; undefined when the rungs cannot be drawn. */
export function layoutLadder(body: LadderBody, options: LayoutOptions): NetworkLayout | undefined {
  const components = ladderComponents(body);
  if (!components || components.length === 0) return undefined;
  const elements: ElementView[] = [];
  const wires: WireView[] = [];
  const starts: StartView[] = [];
  const sizes = new Map<LadderTree, Sized>();
  const size = (t: Extract<LadderTree, { kind: 'element' }>) => {
    let s = sizes.get(t);
    if (!s) {
      s = sizeElement(t.element, t.rung, t.item, options);
      sizes.set(t, s);
    }
    return s;
  };
  const measure = (t: LadderTree): Placed => {
    if (t.kind === 'element') return size(t);
    if (t.kind === 'series') {
      if (t.items.length === 0) return { w: 0, h: 66 };
      let w = 0;
      let h = 0;
      for (const c of t.items) {
        const m = measure(c);
        w += m.w;
        h = Math.max(h, m.h);
      }
      return { w, h };
    }
    let w = 0;
    let h = 0;
    for (const c of t.items) {
      const m = measure(c);
      w = Math.max(w, m.w);
      h += m.h;
    }
    return { w: w + 2 * M.branchPad, h };
  };
  const place = (t: LadderTree, x: number, y: number): Placed => {
    if (t.kind === 'element') {
      const s = size(t);
      elements.push(s.build(x, y));
      return s;
    }
    if (t.kind === 'series') {
      let cx = x;
      let h = t.items.length === 0 ? 66 : 0;
      for (const c of t.items) {
        const m = place(c, cx, y);
        cx += m.w;
        h = Math.max(h, m.h);
      }
      return { w: cx - x, h };
    }
    const total = measure(t);
    const innerW = total.w - 2 * M.branchPad;
    let cy = y;
    const lineYs: number[] = [];
    for (const c of t.items) {
      const m = measure(c);
      const lineY = cy + M.line;
      lineYs.push(lineY);
      wires.push({ x1: x, y1: lineY, x2: x + M.branchPad, y2: lineY });
      place(c, x + M.branchPad, cy);
      const end = x + M.branchPad + m.w;
      if (!t.open) wires.push({ x1: end, y1: lineY, x2: x + total.w, y2: lineY });
      else if (m.w === 0)
        wires.push({ x1: end, y1: lineY, x2: x + M.branchPad + innerW, y2: lineY });
      cy += m.h;
    }
    wires.push({ x1: x, y1: lineYs[0]!, x2: x, y2: lineYs[lineYs.length - 1]! });
    if (!t.open)
      wires.push({
        x1: x + total.w,
        y1: lineYs[0]!,
        x2: x + total.w,
        y2: lineYs[lineYs.length - 1]!,
      });
    return total;
  };

  let y = 8;
  let width = 0;
  let railTop: number | undefined;
  let railBottom = 0;
  for (const c of components) {
    let x = M.rootX;
    const lineY = y + M.line;
    if (c.source.kind === 'powerrail') {
      railTop ??= y;
      wires.push({ x1: M.railX, y1: lineY, x2: x, y2: lineY });
      starts.push({ kind: 'powerrail', operand: undefined, negated: false, x: M.railX, y: lineY });
    } else if (c.source.kind === 'operand') {
      const op = span(options.text, c.source.operand);
      const tw = textWidth(op?.text) + 12;
      starts.push({ kind: 'operand', operand: op, negated: c.source.negated, x: 8, y: lineY });
      wires.push({ x1: 8 + tw, y1: lineY, x2: 8 + tw + 16, y2: lineY });
      x = 8 + tw + 16;
    } else {
      starts.push({ kind: 'none', operand: undefined, negated: false, x: 8, y: lineY });
      x = 8;
    }
    const m = place(c.tree, x, y);
    if (c.source.kind === 'powerrail') railBottom = y + m.h - 8;
    width = Math.max(width, x + m.w);
    y += m.h + 6;
  }
  const rails: WireView[] =
    railTop === undefined
      ? []
      : [{ x1: M.railX, y1: railTop, x2: M.railX, y2: Math.max(railBottom, railTop + 60) }];
  return { width: width + 16, height: y + 4, elements, wires, rails, starts };
}
