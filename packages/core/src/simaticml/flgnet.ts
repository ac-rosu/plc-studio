// A LAD or FBD network of a SimaticML export as SIMATIC SD rungs (ADR 0014), so the LAD/FBD view
// draws it like a .s7dcl network. The XML is a graph: parts (contacts, coils, boxes, calls) whose
// pins are joined by wires; LAD joins parallel branches with an OR part. Every wire that carries
// power is a node, every part an edge between the node at its input and the node at its output;
// rungs are paths through that graph in the order the XML lists the parts, and a node that more
// than one rung reaches gets a name (wire#w1 …), as TIA's own SD export writes them.
import type { LadderElement, ProfileIndex } from '@plcstudio/profiles';
import { child, children, type XmlElement } from '../formats/xml.ts';
import { flgNetOperand } from './structured-text.ts';

export interface FlgNetOptions {
  readonly profile: ProfileIndex;
  readonly language: 'LAD' | 'FBD';
  /** The block's software unit (names of its own objects are written without it). */
  readonly namespace?: string | undefined;
}

/** The network body as SD lines (RUNG at column 0), or why it cannot be drawn. */
export type FlgNetResult = { readonly lines: string[] } | { readonly unsupported: string };

interface Param {
  readonly name: string;
  /** Pin name in the XML; parameters of instructions are compared without case. */
  readonly pin: string;
  readonly output: boolean;
  readonly optional: boolean;
  readonly bool: boolean;
}

interface Part {
  readonly uid: string;
  readonly xml: XmlElement;
  readonly kind: 'element' | 'instruction' | 'call' | 'junction';
  readonly junction: boolean;
  readonly sdName: string;
  readonly params: readonly Param[];
  /** One parameter in all: written as Name( value ). */
  readonly short: boolean;
  readonly negated: ReadonlySet<string>;
  readonly templates: readonly string[];
  readonly inputs: Map<string, string>;
  readonly outputs: Map<string, string>;
  flowIn: string | undefined;
  flowOut: string | undefined;
  from: number | undefined;
  to: number | undefined;
}

const attr = (e: XmlElement | undefined, name: string) => e?.attributes.get(name)?.value ?? '';
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const lower = (s: string) => s.toLowerCase();

class Unsupported extends Error {}

export function flgNetToRungs(flgnet: XmlElement, options: FlgNetOptions): FlgNetResult {
  try {
    return { lines: new Converter(flgnet, options).lines() };
  } catch (e) {
    if (e instanceof Unsupported) return { unsupported: e.message };
    throw e;
  }
}

class Converter {
  private readonly options: FlgNetOptions;
  private readonly operands = new Map<string, string>();
  private readonly parts: Part[] = [];
  private readonly byUid = new Map<string, Part>();
  private readonly labels: string[];
  private readonly parent: number[] = [];
  private power: number | undefined;
  /** Rung starts at an operand (FBD): node → operand text. */
  private readonly operandStarts = new Map<number, string>();

  constructor(flgnet: XmlElement, options: FlgNetOptions) {
    this.options = options;
    this.labels = children(child(flgnet, 'Labels'), 'LabelDeclaration').map((d) =>
      attr(child(d, 'Label'), 'Name'),
    );
    for (const e of child(flgnet, 'Parts')?.children ?? []) {
      if (e.name === 'Access')
        this.operands.set(attr(e, 'UId'), flgNetOperand(e, { namespace: options.namespace }));
      else if (e.name === 'Part') this.add(this.part(e));
      else if (e.name === 'Call') this.add(this.call(e));
      else throw new Unsupported(`${e.name} in the network`);
    }
    for (const w of children(child(flgnet, 'Wires'), 'Wire')) this.wire(w);
  }

  private add(part: Part): void {
    this.parts.push(part);
    this.byUid.set(part.uid, part);
  }

  private base(e: XmlElement): Omit<Part, 'sdName' | 'params' | 'short' | 'junction' | 'kind'> {
    return {
      uid: attr(e, 'UId'),
      xml: e,
      negated: new Set(children(e, 'Negated').map((n) => attr(n, 'Name'))),
      templates: children(e, 'TemplateValue')
        .filter((t) => attr(t, 'Type') !== 'Cardinality')
        .map((t) => `${attr(t, 'Name')} := ${t.text}`),
      inputs: new Map(),
      outputs: new Map(),
      flowIn: undefined,
      flowOut: undefined,
      from: undefined,
      to: undefined,
    };
  }

  private part(e: XmlElement): Part {
    const name = attr(e, 'Name');
    const base = this.base(e);
    // LAD joins parallel branches with an OR part; SD joins them at a named wire
    if (name === 'O' && this.options.language === 'LAD')
      return { ...base, kind: 'junction', junction: true, sdName: '', params: [], short: false };
    const candidates = this.options.profile.profile.ladderElements.filter(
      (l) => l.simaticml?.part === name && l.languages.includes(this.options.language),
    );
    const element =
      candidates.find((l) => l.simaticml?.negated && base.negated.has(l.simaticml.negated)) ??
      candidates.find((l) => !l.simaticml?.negated);
    if (element) return this.fromElement(base, element);
    const instance = child(e, 'Instance');
    const instruction = this.options.profile.instruction(name);
    if (instance && instruction?.kind === 'fb') {
      if (attr(instance, 'Scope') !== 'LocalVariable') throw new Unsupported(`${name} instance`);
      const prefix = `#${children(instance, 'Component')
        .map((c) => attr(c, 'Name'))
        .join('.')}.`;
      return {
        ...base,
        kind: 'instruction',
        junction: false,
        sdName: `${prefix}${name}`,
        params: instruction.parameters.map((p) => ({
          name: lower(p.name),
          pin: p.name,
          output: p.direction === 'out',
          optional: p.optional,
          bool: p.type === 'Bool',
        })),
        short: false,
      };
    }
    throw new Unsupported(`part ${name}`);
  }

  private fromElement(base: ReturnType<Converter['base']>, element: LadderElement): Part {
    return {
      ...base,
      kind: 'element',
      junction: false,
      sdName: element.name,
      params: element.parameters.map((p) => ({
        name: p.name,
        pin: p.name,
        output: p.direction === 'out',
        optional: p.optional,
        bool: p.type === 'Bool',
      })),
      short: element.parameters.length === 1,
    };
  }

  private call(e: XmlElement): Part {
    const info = child(e, 'CallInfo');
    const instance = child(info, 'Instance');
    let sdName: string;
    if (instance && attr(instance, 'Scope') === 'LocalVariable')
      sdName = `#${children(instance, 'Component')
        .map((c) => attr(c, 'Name'))
        .join('.')}`;
    else if (!instance) sdName = this.globalName(attr(info, 'Name'));
    else throw new Unsupported('call with a global instance');
    const order = { Input: 0, InOut: 1, Output: 2 } as Record<string, number>;
    const params = children(info, 'Parameter')
      .map((p, i) => ({ p, i }))
      .sort(
        (a, b) =>
          (order[attr(a.p, 'Section')] ?? 3) - (order[attr(b.p, 'Section')] ?? 3) || a.i - b.i,
      )
      .map(({ p }) => ({
        name: attr(p, 'Name'),
        pin: attr(p, 'Name'),
        output: attr(p, 'Section') === 'Output',
        optional: false,
        bool: attr(p, 'Type') === 'Bool',
      }));
    return { ...this.base(e), kind: 'call', junction: false, sdName, params, short: false };
  }

  private globalName(name: string): string {
    const ns = this.options.namespace;
    if (ns && name.startsWith(`${ns}.`)) {
      const own = name.slice(ns.length + 1);
      return PLAIN.test(own) ? own : `"${own}"`;
    }
    return `"${name}"`;
  }

  // --- wires and nodes -----------------------------------------------------------------------

  private node(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }

  private find(n: number): number {
    while (this.parent[n] !== n) n = this.parent[n] = this.parent[this.parent[n]!]!;
    return n;
  }

  private union(a: number, b: number): number {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
    return ra;
  }

  private wire(w: XmlElement): void {
    const ends = w.children.filter((c) => c.name !== 'OpenCon');
    const ident = ends.find((c) => c.name === 'IdentCon');
    if (ident) {
      const operand = this.operands.get(attr(ident, 'UId'));
      if (operand === undefined) throw new Unsupported('wire to an unknown operand');
      const toPins = ends[0] === ident;
      for (const c of ends.filter((x) => x.name === 'NameCon')) {
        const part = this.byUid.get(attr(c, 'UId'));
        if (!part) throw new Unsupported('wire to an unknown part');
        (toPins ? part.inputs : part.outputs).set(attr(c, 'Name'), operand);
      }
      return;
    }
    const [source, ...sinks] = ends;
    if (!source) return;
    const node = this.node();
    if (source.name === 'Powerrail') {
      this.power = this.power === undefined ? node : this.union(this.power, node);
    } else if (source.name === 'NameCon') {
      const part = this.byUid.get(attr(source, 'UId'));
      if (!part) throw new Unsupported('wire from an unknown part');
      if (part.junction) part.to = part.to === undefined ? node : this.union(part.to, node);
      else this.connect(part, 'out', attr(source, 'Name'), node);
    } else throw new Unsupported(`wire from ${source.name}`);
    for (const sink of sinks) {
      if (sink.name !== 'NameCon') throw new Unsupported(`wire to ${sink.name}`);
      const part = this.byUid.get(attr(sink, 'UId'));
      if (!part) throw new Unsupported('wire to an unknown part');
      if (part.junction) part.from = part.from === undefined ? node : this.union(part.from, node);
      else this.connect(part, 'in', attr(sink, 'Name'), node);
    }
  }

  private connect(part: Part, side: 'in' | 'out', pin: string, node: number): void {
    if (side === 'in') {
      if (part.flowIn !== undefined) throw new Unsupported(`${part.sdName} with two power inputs`);
      part.flowIn = pin;
      part.from = node;
    } else {
      if (part.flowOut !== undefined)
        throw new Unsupported(`${part.sdName} with two power outputs`);
      part.flowOut = pin;
      part.to = node;
    }
  }

  // --- rungs ---------------------------------------------------------------------------------

  lines(): string[] {
    // an OR part is one node: its inputs and its output
    for (const j of this.parts.filter((p) => p.junction))
      if (j.from !== undefined && j.to !== undefined) this.union(j.from, j.to);
    const elements = this.parts.filter((p) => !p.junction);
    for (const p of elements) {
      if (p.from !== undefined) continue;
      // FBD: the rung starts at the operand on the part's power input (in1 of A, en of a box or
      // call, IN of a timer); without one, the rung has no start (RUNG alone, corpus C20)
      const pin =
        p.params.find((x) => x.optional && p.inputs.has(x.pin))?.pin ??
        [...p.inputs.keys()].find((k) => !p.params.some((x) => lower(x.pin) === lower(k))) ??
        (p.kind === 'instruction'
          ? p.params.find((x) => !x.output && x.bool && p.inputs.has(x.pin))?.pin
          : undefined);
      const n = this.node();
      this.operandStarts.set(n, pin === undefined ? '' : p.inputs.get(pin)!);
      if (pin !== undefined) p.flowIn = pin;
      p.from = n;
    }
    const edges = elements.map((p) => ({
      part: p,
      from: this.find(p.from!),
      to: p.to === undefined ? undefined : this.find(p.to),
    }));
    const power = this.power === undefined ? undefined : this.find(this.power);
    const used = new Set<(typeof edges)[number]>();
    const visited: number[] = [];
    type Item = { kind: 'part'; part: Part } | { kind: 'node'; node: number };
    const rungs: { start: number; items: Item[]; end: number | undefined }[] = [];
    const walk = (start: number) => {
      const rung = { start, items: [] as Item[], end: undefined as number | undefined };
      let node = start;
      for (;;) {
        const edge = edges.find((e) => e.from === node && !used.has(e));
        if (!edge) break;
        used.add(edge);
        rung.items.push({ kind: 'part', part: edge.part });
        if (edge.to === undefined) break;
        if (visited.includes(edge.to)) {
          rung.end = edge.to;
          break;
        }
        visited.push(edge.to);
        rung.items.push({ kind: 'node', node: edge.to });
        node = edge.to;
      }
      rungs.push(rung);
    };
    const sources = [
      ...(power !== undefined ? [power] : []),
      ...edges.filter((e) => this.operandStarts.has(e.from)).map((e) => e.from),
    ];
    for (;;) {
      const next =
        visited.find((n) => edges.some((e) => e.from === n && !used.has(e))) ??
        sources.find(
          (n) => !visited.includes(n) && edges.some((e) => e.from === n && !used.has(e)),
        );
      if (next === undefined) break;
      if (!visited.includes(next)) visited.push(next);
      walk(next);
    }
    if (used.size !== edges.length) throw new Unsupported('parts the power never reaches');

    // nodes that more than one rung reaches get a name, in order of appearance
    const uses = new Map<number, number>();
    const count = (n: number) => uses.set(n, (uses.get(n) ?? 0) + 1);
    for (const r of rungs) {
      count(r.start);
      for (const i of r.items) if (i.kind === 'node') count(i.node);
      if (r.end !== undefined) count(r.end);
    }
    const names = new Map<number, string>();
    const name = (n: number) => {
      if (!names.has(n)) names.set(n, `w${names.size + 1}`);
      return names.get(n)!;
    };
    const named = (n: number) =>
      n !== power && !this.operandStarts.has(n) && (uses.get(n) ?? 0) > 1;
    const out = this.labels.map((l) => `Label(${l})`);
    for (const r of rungs) {
      out.push(
        `RUNG ${r.start === power ? 'wire#powerrail' : this.operandStarts.has(r.start) ? this.operandStarts.get(r.start)! : `wire#${name(r.start)}`}`.trimEnd(),
      );
      for (const i of r.items) {
        if (i.kind === 'part') out.push(...this.element(i.part).map((l) => `    ${l}`));
        else if (named(i.node)) out.push(`    wire#${name(i.node)}`);
      }
      out.push(r.end !== undefined ? `END_RUNG wire#${name(r.end)}` : 'END_RUNG');
    }
    return out;
  }

  /** The element as SD writes it, with its template line. */
  private element(p: Part): string[] {
    const lines: string[] = [];
    if (p.templates.length > 0)
      lines.push(
        `{ S7_Templates := "${p.templates.length > 1 ? `[${p.templates.join(', ')}]` : p.templates[0]}" }`,
      );
    // LAD writes an empty line before a box with ENO switched off and nothing to template
    // (Move, Add on the power rail, C17); FBD does not (C20). An interpretation of TIA's output.
    else if (this.options.language === 'LAD' && attr(p.xml, 'DisabledENO') === 'true')
      lines.push('');
    const not = p.flowIn !== undefined && p.negated.has(p.flowIn) ? 'NOT ' : '';
    const flow = [p.flowIn, p.flowOut].filter((x): x is string => x !== undefined).map(lower);
    const values = p.params
      .filter((x) => !flow.includes(lower(x.pin)))
      .map((x) => {
        const key = [...p.inputs.keys(), ...p.outputs.keys()].find(
          (k) => lower(k) === lower(x.pin),
        );
        const value = key === undefined ? undefined : (p.inputs.get(key) ?? p.outputs.get(key));
        return { x, value };
      })
      .filter((v): v is { x: Param; value: string } => v.value !== undefined);
    if (p.short || (p.kind === 'element' && values.length === 1)) {
      if (values.length !== 1) throw new Unsupported(`${p.sdName} without its operand`);
      const { x, value } = values[0]!;
      // one parameter in all: Name( value ); one of several: Name( name := value ) (C19)
      const text = p.short ? value : `${x.name} ${x.output ? '=>' : ':='} ${value}`;
      lines.push(`${not}${p.sdName}( ${text} )`);
      return lines;
    }
    if (values.length === 0) throw new Unsupported(`${p.sdName} without parameters`);
    lines.push(`${not}${p.sdName}(`);
    values.forEach(({ x, value }, i) =>
      lines.push(
        `    ${x.name} ${x.output ? '=>' : ':='} ${value}${i < values.length - 1 ? ',' : ''}`,
      ),
    );
    lines.push(')');
    return lines;
  }
}
