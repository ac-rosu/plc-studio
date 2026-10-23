// Minimal edits: every change is a replacement of an exact range; nothing is re-printed
// wholesale (ADR 0004).
import type { Range } from '../text/source-text.ts';
import type { SourceText } from '../text/source-text.ts';

export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

export function replace(range: Range, newText: string): TextEdit {
  return { start: range.start, end: range.end, newText };
}

export function insert(offset: number, newText: string): TextEdit {
  return { start: offset, end: offset, newText };
}

/** Applies non-overlapping edits. Throws on overlap, so a bug never corrupts a file silently. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) throw new Error('Overlapping edits');
  }
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    out += text.slice(pos, e.start) + e.newText;
    pos = e.end;
  }
  return out + text.slice(pos);
}

/** Lines (0-based) whose text differs between two versions: what an edit touched. */
export function changedLines(before: string, after: string): number[] {
  const a = before.split(/\r\n|\n|\r/);
  const b = after.split(/\r\n|\n|\r/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const out: number[] = [];
  for (let i = head; i < b.length - tail; i++) out.push(i);
  if (out.length === 0 && a.length !== b.length) out.push(head);
  return out;
}

/** Indentation of the line containing an offset. */
export function indentationAt(source: SourceText, offset: number): string {
  const line = source.positionAt(offset).line;
  return /^[ \t]*/.exec(source.lineText(line))![0];
}

/** Text of full lines for insertion, in the file's own line ending. */
export function linesText(source: SourceText, lines: readonly string[]): string {
  return lines.map((l) => l + source.newline).join('');
}
