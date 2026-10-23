// What the LAD/FBD view shows for one block: its networks, laid out, with titles and comments in
// the display language. A network that cannot be drawn keeps its text (spec: "falls back to its
// .s7dcl text inside the view, marked as such").
import type { ProfileIndex } from '@plcstudio/profiles';
import type { Block, BlockFile, LadderElement, Network } from '../syntax/ast.ts';
import type { ResourceFile } from '../formats/s7res.ts';
import { layoutLadder, type NetworkLayout } from './layout.ts';

export type NetworkViewKind = 'drawn' | 'text' | 'fallback' | 'empty';

export interface NetworkView {
  readonly index: number;
  readonly language: Network['language'];
  readonly kind: NetworkViewKind;
  /** Why a network is shown as text. */
  readonly reason: string | undefined;
  readonly title: string | undefined;
  readonly comment: string | undefined;
  readonly titleId: string | undefined;
  readonly commentId: string | undefined;
  /** Texts in every language, for the hover of titles and comments. */
  readonly otherTitles: readonly { culture: string; text: string }[];
  readonly labels: readonly { name: string; start: number; end: number }[];
  readonly range: { start: number; end: number };
  readonly keywordRange: { start: number; end: number };
  /** SCL code or the .s7dcl text of a network that is not drawn. */
  readonly text: string | undefined;
  readonly layout: NetworkLayout | undefined;
}

export interface LadderBlockView {
  readonly name: string;
  readonly kind: Block['kind'];
  readonly namespace: string | undefined;
  readonly failsafe: boolean;
  readonly language: 'LAD' | 'FBD' | 'SCL' | 'unknown';
  readonly displayLanguage: string | undefined;
  readonly languages: readonly string[];
  readonly networks: readonly NetworkView[];
}

export interface LadderViewOptions {
  readonly profile: ProfileIndex;
  /** The .s7res next to the document. */
  readonly resources?: ResourceFile | undefined;
  readonly displayLanguage?: string | undefined;
  readonly describeCall?: (element: LadderElement) => { title: string } | undefined;
}

function texts(
  resources: ResourceFile | undefined,
  id: string | undefined,
  culture: string | undefined,
) {
  if (!resources || !id) return { text: undefined, all: [] as { culture: string; text: string }[] };
  const entry = resources.entries.find((e) => e.id === id);
  const all = entry?.values.map((v) => ({ culture: v.culture, text: v.text })) ?? [];
  const chosen =
    all.find((v) => v.culture === culture) ?? all.find((v) => v.culture.startsWith('en')) ?? all[0];
  return { text: chosen?.text, all };
}

/** The view model of the first code block of a file, or undefined for DBs and UDTs. */
export function ladderBlockView(
  file: BlockFile,
  options: LadderViewOptions,
): LadderBlockView | undefined {
  const block = file.blocks.find((b) => b.kind === 'FB' || b.kind === 'FC' || b.kind === 'OB');
  if (!block) return undefined;
  const text = file.source.text;
  const cultures = new Set<string>();
  for (const e of options.resources?.entries ?? [])
    for (const v of e.values) cultures.add(v.culture);
  const display = options.displayLanguage ?? (cultures.has('en-US') ? 'en-US' : [...cultures][0]);
  const safety = block.attributes.find((a) => a.name === 'S7_Safety')?.value;
  const preferred = block.attributes
    .find((a) => a.name === 'S7_PreferredLanguage' || a.name === 'S7_EditorMode')
    ?.value.toUpperCase();
  const networks = block.networks.map((n) => networkView(file, block, n, text, display, options));
  return {
    name: block.name.text,
    kind: block.kind,
    namespace: block.namespace,
    failsafe: safety !== undefined && /^true$/i.test(safety),
    language:
      preferred === 'LAD' || preferred === 'FBD' || preferred === 'SCL' ? preferred : 'unknown',
    displayLanguage: display,
    languages: [...cultures].sort(),
    networks,
  };
}

function networkView(
  file: BlockFile,
  block: Block,
  n: Network,
  text: string,
  display: string | undefined,
  options: LadderViewOptions,
): NetworkView {
  const title = texts(options.resources, n.titleId, display);
  const comment = texts(options.resources, n.commentId, display);
  const base = {
    index: n.index,
    language: n.language,
    title: title.text,
    comment: comment.text,
    titleId: n.titleId,
    commentId: n.commentId,
    otherTitles: title.all,
    labels: (n.ladder?.labels ?? []).map((l) => ({
      name: l.name.text,
      start: l.range.start,
      end: l.range.end,
    })),
    range: { start: n.range.start, end: n.range.end },
    keywordRange: { start: n.keywordRange.start, end: n.keywordRange.end },
  };
  const body = text
    .slice(n.bodyRange.start, n.bodyRange.end)
    .replace(/^([ \t]*\r?\n)+/, '')
    .replace(/\s+$/, '');
  if (n.language === 'SCL')
    return { ...base, kind: 'text', reason: 'SCL network', text: dedent(body), layout: undefined };
  if (!n.ladder)
    return {
      ...base,
      kind: 'fallback',
      reason: `network in ${n.language === 'unknown' ? 'a language PLC Studio does not draw' : n.language}`,
      text: dedent(body),
      layout: undefined,
    };
  const problem = file.diagnostics.find(
    (d) =>
      d.range.start >= n.range.start &&
      d.range.end <= n.range.end &&
      (d.severity === 'error' || d.code === 'not-analyzed'),
  );
  if (problem)
    return {
      ...base,
      kind: 'fallback',
      reason:
        problem.severity === 'error'
          ? 'the network has a syntax error'
          : 'part of the network was not analyzed',
      text: dedent(body),
      layout: undefined,
    };
  if (
    n.ladder.rungs.length === 0 ||
    n.ladder.rungs.every((r) => r.items.every((i) => i.kind === 'junction'))
  ) {
    return {
      ...base,
      kind: 'empty',
      reason: 'the network has no elements yet',
      text: dedent(body),
      layout: undefined,
    };
  }
  let layout: NetworkLayout | undefined;
  try {
    layout = layoutLadder(n.ladder, {
      profile: options.profile,
      language: n.language === 'FBD' ? 'FBD' : 'LAD',
      network: n.index,
      text,
      ...(options.describeCall ? { describeCall: options.describeCall } : {}),
    });
  } catch {
    layout = undefined;
  }
  if (!layout)
    return {
      ...base,
      kind: 'fallback',
      reason: 'the branches of this network could not be drawn',
      text: dedent(body),
      layout: undefined,
    };
  void block;
  return { ...base, kind: 'drawn', reason: undefined, text: undefined, layout };
}

function dedent(text: string): string {
  const lines = text.split(/\r?\n/);
  const indents = lines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join('\n');
}
