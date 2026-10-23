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
