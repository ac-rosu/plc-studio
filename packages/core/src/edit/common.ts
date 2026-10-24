// Shared helpers for edit operations: whole-line spans, indentation and the result shape.
// Every operation returns minimal text edits; nothing is re-printed wholesale (ADR 0004).
import type { Range } from '../text/source-text.ts';
import type { SourceText } from '../text/source-text.ts';
import type { TextEdit } from '../writer/text-edit.ts';

export interface EditResult {
  /** Edits on the file being edited. */
  readonly edits: readonly TextEdit[];
  /** Edits on the .s7res next to it, when texts change. */
  readonly resourceEdits?: readonly TextEdit[];
  /** Full text of a new .s7res, when the block had none yet. */
  readonly newResourceText?: string;
  /** Edits on other files (renames that follow references), by path. */
  readonly otherFiles?: ReadonlyMap<string, readonly TextEdit[]>;
  /** Set when the operation is not possible; edits are then empty. */
  readonly error?: string;
}

export const failed = (error: string): EditResult => ({ edits: [], error });

/** The full lines covering a range, including the line break of the last line. */
export function lineSpan(source: SourceText, range: Range): Range {
  const first = source.positionAt(range.start).line;
  const last = source.positionAt(Math.max(range.start, range.end - 1)).line;
  return {
    start: source.lineStart(first),
    end: last + 1 < source.lineCount ? source.lineStart(last + 1) : source.text.length,
  };
}

export function indentOf(source: SourceText, offset: number): string {
  return /^[ \t]*/.exec(source.lineText(source.positionAt(offset).line))![0];
}

/** Offset right after the line containing `offset` (start of the next line). */
export function afterLine(source: SourceText, offset: number): number {
  const line = source.positionAt(offset).line;
  return line + 1 < source.lineCount ? source.lineStart(line + 1) : source.text.length;
}

export function lineStartOf(source: SourceText, offset: number): number {
  return source.lineStart(source.positionAt(offset).line);
}

/** Lines with their line breaks, so joining them gives the text back. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

interface Hunk {
  readonly aStart: number;
  readonly aEnd: number;
  readonly bStart: number;
  readonly bEnd: number;
}

/** Myers' O(ND) line diff; undefined when more than `maxD` lines differ. */
function lineHunks(a: readonly string[], b: readonly string[], maxD: number): Hunk[] | undefined {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  let v: Int32Array = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= Math.min(n + m, maxD) && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return undefined;
  // walk back from the end, collecting the matched line pairs
  const matches: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) matches.push([--x, --y]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) matches.push([--x, --y]);
  matches.reverse();
  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ma, mb] of [...matches, [n, m] as [number, number]]) {
    if (ma > ai || mb > bi) hunks.push({ aStart: ai, aEnd: ma, bStart: bi, bEnd: mb });
    ai = ma + 1;
    bi = mb + 1;
  }
  return hunks;
}

/**
 * The minimal line edits that turn `before` into `after`: unchanged lines are never part of an
 * edit. Used to apply several steps computed one after the other as a single change.
 */
export function lineDiffEdits(before: string, after: string): TextEdit[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const starts = [0];
  for (const line of a) starts.push(starts.at(-1)! + line.length);
  const hunks = lineHunks(midA, midB, 2000) ?? [
    { aStart: 0, aEnd: midA.length, bStart: 0, bEnd: midB.length },
  ];
  return hunks.map((h) => ({
    start: starts[prefix + h.aStart]!,
    end: starts[prefix + h.aEnd]!,
    newText: midB.slice(h.bStart, h.bEnd).join(''),
  }));
}
