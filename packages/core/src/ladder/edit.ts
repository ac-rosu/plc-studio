// Edits of LAD/FBD networks (spec M10, "LAD/FBD editor"). Every operation returns minimal text
// edits that touch only the lines of the affected network, written the way TIA writes them
// (indentation, line endings, element forms), so the rest of the file stays byte-identical.
import type { ProfileIndex } from '@plcstudio/profiles';
import { newResourceId, quoteResourceValue, type ResourceFile } from '../formats/s7res.ts';
import type { Block, BlockFile, LadderElement, Network, Rung } from '../syntax/ast.ts';
import { parseBlockFile, Parser } from '../syntax/parser.ts';
import { SourceText } from '../text/source-text.ts';
import type { TextEdit } from '../writer/text-edit.ts';

export interface ElementRef {
  readonly network: number;
  readonly rung: number;
  readonly item: number;
}

export interface NetworkClipboard {
  /** The network's lines, as written (attribute block included), with the source indentation. */
  readonly text: string;
  readonly indent: string;
  /** Title and comment texts per culture, so a paste can create new ids. */
  readonly texts: {
    readonly role: 'title' | 'comment';
    readonly values: readonly { culture: string; text: string }[];
  }[];
  /** Local names (#Name) the network uses. */
  readonly locals: readonly string[];
  readonly language: string;
}

export interface LadderEditResult {
  /** Edits of the .s7dcl. */
  readonly edits: TextEdit[];
  /** Edits of the .s7res next to it. */
  readonly resourceEdits?: TextEdit[];
  /** Content for a new .s7res when there is none yet. */
  readonly resourceCreate?: string;
  /** What to select after the edit (the text is parsed again, so indexes are new). */
  readonly select?: { readonly network: number; readonly rung?: number; readonly item?: number };
  /** Locals a pasted network uses that the target block does not declare. */
  readonly missingDeclarations?: string[];
  readonly clipboard?: NetworkClipboard;
}

export type LadderEditOutcome = LadderEditResult | { readonly error: string };

export interface NewElement {
  readonly name: string;
  readonly negated?: boolean;
  /** Positional operand: Contact( #Start ). */
  readonly operand?: string;
  /** Formal parameters: Move( in := #a, out1 => #b ). */
  readonly args?: readonly {
    readonly name: string;
    readonly direction: 'in' | 'out';
    readonly value: string;
  }[];
  /** S7_Templates value, e.g. "SrcType := Int". */
  readonly template?: string;
}

/** Placeholder for operands the user still has to fill in; the checker reports it until then. */
export const NEW_OPERAND = '#NewOperand';

// --- Text helpers ---------------------------------------------------------------------------

function lineStart(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && text[i - 1] !== '\n' && text[i - 1] !== '\r') i--;
  return i;
}

function nextLineStart(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
  if (text[i] === '\r') i++;
  if (text[i] === '\n') i++;
  return i;
}

function indentAt(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset)))![0];
}

function newlineOf(text: string): string {
  return new SourceText(text).newline;
}

interface Located {
  readonly file: BlockFile;
  readonly block: Block;
  readonly text: string;
  readonly nl: string;
}

function locate(text: string): Located | { error: string } {
  const file = parseBlockFile(new SourceText(text), 's7dcl');
  const block = file.blocks.find((b) => b.kind === 'FB' || b.kind === 'FC' || b.kind === 'OB');
  if (!block) return { error: 'This file has no code block.' };
  return { file, block, text, nl: newlineOf(text) };
}

function network(l: Located, index: number): Network | undefined {
  return l.block.networks.find((n) => n.index === index);
}

function ladderNetwork(
  l: Located,
  index: number,
): { net: Network; rungs: readonly Rung[] } | { error: string } {
  const net = network(l, index);
  if (!net) return { error: `Network ${index} does not exist (the text may have changed).` };
  if (!net.ladder) return { error: `Network ${index} is not a LAD/FBD network.` };
  return { net, rungs: net.ladder.rungs };
}

function elementAt(
  l: Located,
  ref: ElementRef,
): { net: Network; rung: Rung; element: LadderElement } | { error: string } {
  const found = ladderNetwork(l, ref.network);
  if ('error' in found) return found;
  const rung = found.rungs[ref.rung];
  const item = rung?.items[ref.item];
  if (!rung || !item || item.kind !== 'element')
    return { error: 'That element no longer exists (the text may have changed).' };
  return { net: found.net, rung, element: item };
}

/** Full lines of an element, its template line included. */
function elementLines(text: string, element: LadderElement): { start: number; end: number } {
  let start = lineStart(text, element.range.start);
  if (element.templates.length > 0) {
    const prev = lineStart(text, Math.max(0, start - 1));
    if (/^\s*\{\s*S7_Templates/.test(text.slice(prev, start))) start = prev;
  }
  return { start, end: nextLineStart(text, element.range.end) };
}

function networkLines(text: string, net: Network): { start: number; end: number } {
  return { start: lineStart(text, net.range.start), end: nextLineStart(text, net.range.end) };
}

function rungLines(text: string, rung: Rung): { start: number; end: number } {
  return { start: lineStart(text, rung.range.start), end: nextLineStart(text, rung.range.end) };
}

/** Indentation of the elements of a rung. */
function itemIndent(l: Located, rung: Rung): string {
  const first = rung.items[0];
  return first ? indentAt(l.text, first.range.start) : indentAt(l.text, rung.range.start) + '    ';
}

/** True when the text is one complete operand expression. */
export function isValidOperand(text: string): boolean {
  if (text.trim() === '') return false;
  const p = new Parser(new SourceText(text));
  p.parseExpression();
  return p.tok().kind === 42 /* EOF */ && p.diagnostics.length === 0;
}

/** The text TIA writes for an element. */
export function elementText(e: NewElement, indent: string, nl: string): string {
  const neg = e.negated ? 'NOT ' : '';
  const template = e.template ? `${indent}{ S7_Templates := "${e.template}" }${nl}` : '';
  if (!e.args || e.args.length === 0) {
    return `${template}${indent}${neg}${e.name}( ${e.operand ?? ''} )${nl}`.replace('(  )', '()');
  }
  const lines = e.args.map(
    (a, i) =>
      `${indent}    ${a.name} ${a.direction === 'out' ? '=>' : ':='} ${a.value}${i < e.args!.length - 1 ? ',' : ''}`,
  );
  return `${template}${indent}${neg}${e.name}(${nl}${lines.join(nl)}${nl}${indent})${nl}`;
}

/** What the palette inserts for an element of the profile. */
export function paletteElement(
  profile: ProfileIndex,
  name: string,
  language: 'LAD' | 'FBD',
): NewElement | undefined {
  const el = profile.ladderElement(name);
  if (!el) return undefined;
  if (el.shape === 'jump') return { name: el.name, operand: 'Label1' };
  const positional =
    el.parameters.length === 1 &&
    (el.shape === 'contact' || el.shape === 'coil' || el.name === 'P_Trig' || el.name === 'N_Trig');
  if (positional) return { name: el.name, operand: NEW_OPERAND };
  const args = el.parameters
    .filter((p) => p.direction !== 'out' || el.shape === 'coil')
    .filter((p) => !(language === 'FBD' && p.optional))
    .map((p) => ({
      name: p.name,
      direction: p.direction === 'out' ? ('out' as const) : ('in' as const),
      value: NEW_OPERAND,
    }));
  const outs = el.parameters
    .filter((p) => p.direction === 'out' && el.shape !== 'coil')
    .map((p) => ({ name: p.name, direction: 'out' as const, value: NEW_OPERAND }));
  return {
    name: el.name,
    args: [...args, ...outs],
    ...(el.template ? { template: `${el.template} := Int` } : {}),
  };
}

// --- Operands -------------------------------------------------------------------------------

/** Replaces an operand; `expected` guards against edits on a text that changed meanwhile. */
export function setOperand(
  text: string,
  start: number,
  end: number,
  expected: string,
  newText: string,
): LadderEditOutcome {
  if (text.slice(start, end) !== expected) return { error: 'The text changed; try again.' };
  const value = newText.trim();
  if (!isValidOperand(value)) return { error: `"${value}" is not a valid operand.` };
  return { edits: [{ start, end, newText: value }] };
}

/** Connects an input or output of a box that has nothing connected yet (B19: Add without in2). */
export function connectPin(
  text: string,
  ref: ElementRef,
  pin: string,
  direction: 'in' | 'out',
  value: string,
): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const found = elementAt(l, ref);
  if ('error' in found) return found;
  if (!isValidOperand(value)) return { error: `"${value}" is not a valid operand.` };
  const el = found.element;
  if (el.args.some((a) => a.name?.text.toLowerCase() === pin.toLowerCase()))
    return { error: `${pin} is already connected.` };
  const op = direction === 'out' ? '=>' : ':=';
  const last = el.args[el.args.length - 1];
  const indent = indentAt(text, el.range.start);
  if (!last) {
    // Name() or Name( ) → multi-line form
    const open = text.indexOf('(', el.callee.range.end);
    return {
      edits: [
        {
          start: open,
          end: el.range.end,
          newText: `(${l.nl}${indent}    ${pin} ${op} ${value}${l.nl}${indent})`,
        },
      ],
      select: ref,
    };
  }
  if (last.direction === 'positional') return { error: 'This element takes a single operand.' };
  // inputs go before the first output, as TIA writes them
  const firstOut = el.args.find((a) => a.direction === 'out');
  if (
    direction === 'in' &&
    firstOut &&
    lineStart(text, firstOut.range.start) !== lineStart(text, el.range.start)
  ) {
    const at = lineStart(text, firstOut.range.start);
    return {
      edits: [
        {
          start: at,
          end: at,
          newText: `${indentAt(text, firstOut.range.start)}${pin} ${op} ${value},${l.nl}`,
        },
      ],
      select: ref,
    };
  }
  const sameLine = lineStart(text, last.range.start) === lineStart(text, el.range.start);
  const insertion = sameLine
    ? `, ${pin} ${op} ${value}`
    : `,${l.nl}${indentAt(text, last.range.start)}${pin} ${op} ${value}`;
  return {
    edits: [{ start: last.range.end, end: last.range.end, newText: insertion }],
    select: ref,
  };
}

// --- Elements -------------------------------------------------------------------------------

/** Inserts an element before item `ref.item` of the rung (or at its end when item = -1). */
export function insertElement(
  text: string,
  ref: ElementRef,
  element: NewElement,
): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const found = ladderNetwork(l, ref.network);
  if ('error' in found) return found;
  const rung = found.rungs[ref.rung];
  if (!rung) return { error: 'That rung no longer exists.' };
  const indent = itemIndent(l, rung);
  const item = ref.item >= 0 ? rung.items[ref.item] : undefined;
  let at: number;
  if (item)
    at =
      item.kind === 'element' ? elementLines(text, item).start : lineStart(text, item.range.start);
  else {
    // before END_RUNG
    const endRung = text.lastIndexOf('END_RUNG', rung.range.end);
    at = lineStart(text, endRung);
  }
  const index = item ? ref.item : rung.items.length;
  return {
    edits: [{ start: at, end: at, newText: elementText(element, indent, l.nl) }],
    select: { network: ref.network, rung: ref.rung, item: index },
  };
}

export function deleteElement(text: string, ref: ElementRef): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const found = elementAt(l, ref);
  if ('error' in found) return found;
  const elements = found.rung.items.filter((i) => i.kind === 'element');
  if (elements.length === 1) {
    if (found.net.ladder!.rungs.length > 1) return deleteBranch(text, ref.network, ref.rung);
    return { error: 'This is the last element of the network; delete the network instead.' };
  }
  const lines = elementLines(text, found.element);
  return {
    edits: [{ start: lines.start, end: lines.end, newText: '' }],
    select: { network: ref.network },
  };
}

/** Swaps an element with its neighbour in the same rung (direction -1: left, +1: right). */
export function moveElement(text: string, ref: ElementRef, direction: -1 | 1): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const found = elementAt(l, ref);
  if ('error' in found) return found;
  const neighbour = found.rung.items[ref.item + direction];
  if (!neighbour) return { error: 'The element is already at the end of its rung.' };
  if (neighbour.kind !== 'element')
    return { error: 'Elements cannot be moved across a branch point.' };
  const a = elementLines(text, direction < 0 ? neighbour : found.element);
  const b = elementLines(text, direction < 0 ? found.element : neighbour);
  const first = text.slice(a.start, a.end);
  const second = text.slice(b.start, b.end);
  const between = text.slice(a.end, b.start);
  return {
    edits: [{ start: a.start, end: b.end, newText: second + between + first }],
    select: { network: ref.network, rung: ref.rung, item: ref.item + direction },
  };
}

// --- Branches -------------------------------------------------------------------------------

function wireNames(net: Network): Set<string> {
  const names = new Set<string>();
  for (const r of net.ladder?.rungs ?? []) {
    if (r.start.kind === 'wire') names.add(r.start.name.toLowerCase());
    if (r.end) names.add(r.end.name.toLowerCase());
    for (const i of r.items) if (i.kind === 'junction') names.add(i.name.toLowerCase());
  }
  return names;
}

function newWire(taken: Set<string>): string {
  for (let i = 1; ; i++) {
    if (!taken.has(`w${i}`)) {
      taken.add(`w${i}`);
      return `w${i}`;
    }
  }
}

/**
 * Adds a branch parallel to the elements from..to of a rung. The branch starts with a copy of the
 * first element (TIA cannot import an empty rung). When nothing follows `to`, the branch stays
 * open (it ends at its own coil).
 */
export function addParallelBranch(
  text: string,
  ref: ElementRef,
  toItem: number = ref.item,
): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const found = elementAt(l, ref);
  if ('error' in found) return found;
  const { net, rung } = found;
  const last = rung.items[toItem];
  if (!last || last.kind !== 'element' || toItem < ref.item)
    return { error: 'Choose a range of elements in one rung.' };
  for (let i = ref.item; i <= toItem; i++)
    if (rung.items[i]!.kind !== 'element') return { error: 'The range crosses a branch point.' };
  const taken = wireNames(net);
  const indent = itemIndent(l, rung);
  const edits: TextEdit[] = [];
  // wire at the start of the range
  const before = rung.items[ref.item - 1];
  let startWire: string;
  if (before?.kind === 'junction') startWire = before.name;
  else if (ref.item === 0 && rung.start.kind === 'wire') startWire = rung.start.name;
  else if (ref.item === 0 && rung.start.kind === 'powerrail') startWire = 'powerrail';
  else {
    startWire = newWire(taken);
    const at = elementLines(text, found.element).start;
    edits.push({ start: at, end: at, newText: `${indent}wire#${startWire}${l.nl}` });
  }
  // wire at the end of the range, unless nothing follows (open branch)
  const after = rung.items[toItem + 1];
  let endWire: string | undefined;
  if (after?.kind === 'junction') endWire = after.name;
  else if (after) {
    endWire = newWire(taken);
    const at = elementLines(text, last).end;
    edits.push({ start: at, end: at, newText: `${indent}wire#${endWire}${l.nl}` });
  } else if (rung.end) endWire = rung.end.name;
  const rungIndent = indentAt(text, rung.range.start);
  const copy = text.slice(
    elementLines(text, found.element).start,
    elementLines(text, found.element).end,
  );
  const branch =
    `${rungIndent}RUNG wire#${startWire}${l.nl}` +
    copy.replace(/^[ \t]*/gm, (m) =>
      m.length >= indent.length ? indent + m.slice(indent.length) : indent,
    ) +
    `${rungIndent}END_RUNG${endWire ? ` wire#${endWire}` : ''}${l.nl}`;
  const at = rungLines(text, rung).end;
  edits.push({ start: at, end: at, newText: branch });
  return { edits, select: { network: ref.network, rung: net.ladder!.rungs.length, item: 0 } };
}

/** Deletes a rung that starts at a wire (a branch), and the branch points nothing uses any more. */
export function deleteBranch(
  text: string,
  networkIndex: number,
  rungIndex: number,
): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const found = ladderNetwork(l, networkIndex);
  if ('error' in found) return found;
  const rung = found.rungs[rungIndex];
  if (!rung) return { error: 'That rung no longer exists.' };
  const others = found.rungs.filter((r) => r !== rung);
  if (others.length === 0)
    return { error: 'This is the only rung of the network; delete the network instead.' };
  if (rung.start.kind === 'powerrail' && !others.some((r) => r.start.kind === 'powerrail')) {
    return { error: 'This rung starts the network; delete the branches first.' };
  }
  const edits: TextEdit[] = [];
  const lines = rungLines(text, rung);
  edits.push({ start: lines.start, end: lines.end, newText: '' });
  // count uses of each wire in the remaining rungs
  const uses = new Map<string, number>();
  const use = (n: string) => uses.set(n.toLowerCase(), (uses.get(n.toLowerCase()) ?? 0) + 1);
  for (const r of others) {
    if (r.start.kind === 'wire') use(r.start.name);
    if (r.end) use(r.end.name);
    for (const i of r.items) if (i.kind === 'junction') use(i.name);
  }
  for (const r of others) {
    for (const i of r.items) {
      if (i.kind === 'junction' && (uses.get(i.name.toLowerCase()) ?? 0) <= 1) {
        edits.push({
          start: lineStart(text, i.range.start),
          end: nextLineStart(text, i.range.end),
          newText: '',
        });
      }
    }
    if (r.end && (uses.get(r.end.name.toLowerCase()) ?? 0) <= 1) {
      edits.push({ start: r.end.range.start - 1, end: r.end.range.end, newText: '' });
    }
  }
  return { edits, select: { network: networkIndex } };
}

// --- Networks -------------------------------------------------------------------------------

function networkIndent(l: Located): string {
  const first = l.block.networks[0];
  if (first) return indentAt(l.text, first.keywordRange.start);
  return indentAt(l.text, l.block.range.start) + '    ';
}

/** Offset where a network inserted after network `after` (0 = first) goes. */
function insertionPoint(l: Located, after: number): number {
  const nets = l.block.networks;
  if (after > 0 && nets[after - 1]) return networkLines(l.text, nets[after - 1]!).end;
  if (nets[0]) return networkLines(l.text, nets[0]).start;
  // no networks yet: before END_FUNCTION / END_FUNCTION_BLOCK / END_ORGANIZATION_BLOCK
  const endKeyword = /END_(FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK)\s*$/.exec(
    l.text.slice(0, l.block.range.end),
  );
  return lineStart(l.text, endKeyword ? endKeyword.index : l.block.range.end);
}

/** A new, empty LAD or FBD network. TIA cannot import an empty rung: add elements first. */
export function addNetwork(
  text: string,
  after: number,
  language: 'LAD' | 'FBD',
): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const ind = networkIndent(l);
  const nl = l.nl;
  const rung =
    language === 'LAD'
      ? `${ind}    RUNG wire#powerrail${nl}${ind}    END_RUNG${nl}`
      : `${ind}    RUNG${nl}${ind}    END_RUNG${nl}`;
  const body = `${ind}{ S7_Language := "${language}" }${nl}${ind}NETWORK${nl}${rung}${ind}END_NETWORK${nl}`;
  const at = insertionPoint(l, Math.min(after, l.block.networks.length));
  return {
    edits: [{ start: at, end: at, newText: body }],
    select: { network: Math.min(after, l.block.networks.length) + 1 },
  };
}

export function deleteNetwork(text: string, index: number): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const net = network(l, index);
  if (!net) return { error: `Network ${index} does not exist.` };
  const lines = networkLines(text, net);
  return {
    edits: [{ start: lines.start, end: lines.end, newText: '' }],
    select: { network: Math.max(1, index - 1) },
  };
}

export function moveNetwork(text: string, index: number, direction: -1 | 1): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const net = network(l, index);
  const other = network(l, index + direction);
  if (!net || !other) return { error: 'The network cannot move further.' };
  const a = networkLines(text, direction < 0 ? other : net);
  const b = networkLines(text, direction < 0 ? net : other);
  const first = text.slice(a.start, a.end);
  const second = text.slice(b.start, b.end);
  return {
    edits: [{ start: a.start, end: b.end, newText: second + text.slice(a.end, b.start) + first }],
    select: { network: index + direction },
  };
}

function textsOf(resources: ResourceFile | undefined, id: string | undefined) {
  return (
    resources?.entries
      .find((e) => e.id === id)
      ?.values.map((v) => ({ culture: v.culture, text: v.text })) ?? []
  );
}

/** Copies a network for pasting into this or another block. */
export function copyNetwork(
  text: string,
  index: number,
  resources: ResourceFile | undefined,
): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const net = network(l, index);
  if (!net) return { error: `Network ${index} does not exist.` };
  const lines = networkLines(text, net);
  const body = text.slice(lines.start, lines.end);
  // #Name and #"Name", but not wire#w1
  const locals = [
    ...new Set(
      [...body.matchAll(/(?<![A-Za-z0-9_])#(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)].map(
        (m) => m[1] ?? m[2]!,
      ),
    ),
  ];
  const texts: NetworkClipboard['texts'][number][] = [];
  if (net.titleId) texts.push({ role: 'title', values: textsOf(resources, net.titleId) });
  if (net.commentId) texts.push({ role: 'comment', values: textsOf(resources, net.commentId) });
  return {
    edits: [],
    clipboard: {
      text: body,
      indent: indentAt(text, net.keywordRange.start),
      texts,
      locals,
      language: net.language,
    },
  };
}

/**
 * Pastes a copied network after network `after`. Title and comment get new ids with the copied
 * texts; locals the target block does not declare are reported (the extension offers to declare
 * them).
 */
export function pasteNetwork(
  text: string,
  after: number,
  clip: NetworkClipboard,
  resources: ResourceFile | undefined,
): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const ind = networkIndent(l);
  let body = clip.text.replace(/\r?\n/g, l.nl);
  if (ind !== clip.indent) {
    body = body
      .split(l.nl)
      .map((line) => (line.startsWith(clip.indent) ? ind + line.slice(clip.indent.length) : line))
      .join(l.nl);
  }
  // new ids for title and comment
  const ids = new Set<string>(resources?.entries.map((e) => e.id) ?? []);
  for (const m of l.text.matchAll(/"(MLC_[A-Za-z0-9_]+)"/g)) ids.add(m[1]!);
  const added: { id: string; values: readonly { culture: string; text: string }[] }[] = [];
  for (const role of ['title', 'comment'] as const) {
    const attr = role === 'title' ? 'S7_NetworkTitle' : 'S7_NetworkComment';
    const pattern = new RegExp(`(${attr}\\s*:=\\s*")([^"]*)(")`);
    const m = pattern.exec(body);
    if (!m) continue;
    const id = newResourceId(ids);
    ids.add(id);
    body = body.replace(pattern, `$1${id}$3`);
    added.push({ id, values: clip.texts.find((t) => t.role === role)?.values ?? [] });
  }
  const at = insertionPoint(l, Math.min(after, l.block.networks.length));
  const declared = new Set(
    l.block.sections.flatMap((s) => s.members.map((m) => m.name.text.toLowerCase())),
  );
  const missing = clip.locals.filter((n) => !declared.has(n.toLowerCase()));
  const result: LadderEditResult = {
    edits: [{ start: at, end: at, newText: body }],
    select: { network: Math.min(after, l.block.networks.length) + 1 },
    missingDeclarations: missing,
    ...resourceAdditions(
      resources,
      added.filter((a) => a.values.length > 0),
      l.nl,
    ),
  };
  return result;
}

/** Duplicates a network right after itself (new ids for its texts). */
export function duplicateNetwork(
  text: string,
  index: number,
  resources: ResourceFile | undefined,
): LadderEditOutcome {
  const copied = copyNetwork(text, index, resources);
  if ('error' in copied) return copied;
  return pasteNetwork(text, index, copied.clipboard!, resources);
}

function resourceAdditions(
  resources: ResourceFile | undefined,
  entries: readonly { id: string; values: readonly { culture: string; text: string }[] }[],
  nl: string,
): Pick<LadderEditResult, 'resourceEdits' | 'resourceCreate'> {
  if (entries.length === 0) return {};
  const lines = entries.flatMap((e) => [
    `  - id: ${e.id}`,
    ...[...e.values]
      .sort((a, b) => a.culture.localeCompare(b.culture))
      .map((v) => `    ${v.culture}: ${quoteResourceValue(v.text)}`),
  ]);
  if (!resources) return { resourceCreate: `MultiLingualTexts:${nl}${lines.join(nl)}${nl}` };
  const text = resources.source.text;
  const resNl = resources.source.newline;
  const at = text.length;
  const prefix = text.length > 0 && !text.endsWith('\n') && !text.endsWith('\r') ? resNl : '';
  return { resourceEdits: [{ start: at, end: at, newText: prefix + lines.join(resNl) + resNl }] };
}

// --- Titles and comments ---------------------------------------------------------------------

/**
 * Sets a network's title or comment in one language. Existing ids are kept; a network without one
 * gets a new id in TIA's form, added to its attribute block.
 */
export function setNetworkText(
  text: string,
  index: number,
  role: 'title' | 'comment',
  culture: string,
  value: string,
  resources: ResourceFile | undefined,
): LadderEditOutcome {
  const l = locate(text);
  if ('error' in l) return l;
  const net = network(l, index);
  if (!net) return { error: `Network ${index} does not exist.` };
  const id = role === 'title' ? net.titleId : net.commentId;
  if (id) {
    const entry = resources?.entries.find((e) => e.id === id);
    if (entry && resources) {
      const existing = entry.values.find((v) => v.culture === culture);
      const resText = resources.source.text;
      const resNl = resources.source.newline;
      if (existing) {
        if (value === '') {
          return {
            edits: [],
            resourceEdits: [
              {
                start: existing.lineRange.start,
                end: nextLineStart(resText, existing.lineRange.end),
                newText: '',
              },
            ],
          };
        }
        return {
          edits: [],
          resourceEdits: [
            {
              start: existing.valueRange.start,
              end: existing.valueRange.end,
              newText: quoteResourceValue(value),
            },
          ],
        };
      }
      if (value === '') return { edits: [] };
      // keep cultures in alphabetical order, as TIA writes them
      const before = [...entry.values].reverse().find((v) => v.culture.localeCompare(culture) < 0);
      const at = before
        ? nextLineStart(resText, before.lineRange.end)
        : nextLineStart(resText, entry.idRange.end);
      return {
        edits: [],
        resourceEdits: [
          { start: at, end: at, newText: `    ${culture}: ${quoteResourceValue(value)}${resNl}` },
        ],
      };
    }
    return {
      edits: [],
      ...resourceAdditions(resources, [{ id, values: [{ culture, text: value }] }], l.nl),
    };
  }
  if (value === '') return { edits: [] };
  const ids = new Set<string>(resources?.entries.map((e) => e.id) ?? []);
  for (const m of l.text.matchAll(/"(MLC_[A-Za-z0-9_]+)"/g)) ids.add(m[1]!);
  const newId = newResourceId(ids);
  const attrName = role === 'title' ? 'S7_NetworkTitle' : 'S7_NetworkComment';
  const ind = indentAt(text, net.keywordRange.start);
  const attrs = [
    ...(net.attributeBlock?.attributes ?? []).map((a) => ({ name: a.name, value: a.value })),
    { name: attrName, value: newId },
  ].sort((a, b) => a.name.localeCompare(b.name));
  const block = `${ind}{${l.nl}${attrs.map((a, i) => `${ind}    ${a.name} := "${a.value}"${i < attrs.length - 1 ? ';' : ''}`).join(l.nl)}${l.nl}${ind}}${l.nl}`;
  const start = lineStart(text, net.attributeBlock?.range.start ?? net.keywordRange.start);
  const end = net.attributeBlock ? nextLineStart(text, net.attributeBlock.range.end) : start;
  return {
    edits: [{ start, end, newText: block }],
    ...resourceAdditions(resources, [{ id: newId, values: [{ culture, text: value }] }], l.nl),
  };
}
