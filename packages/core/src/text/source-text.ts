// Text of one file as TIA wrote it: decoded once, with everything needed to write it back
// byte for byte (ADR 0004).

export type LineEnding = 'crlf' | 'lf' | 'cr' | 'mixed' | 'none';

export interface Position {
  /** 0-based line. */
  readonly line: number;
  /** 0-based column in UTF-16 code units. */
  readonly character: number;
}

export interface Range {
  readonly start: number;
  readonly end: number;
}

export class SourceText {
  readonly text: string;
  readonly bom: boolean;
  readonly lineEnding: LineEnding;
  private lineStarts: number[] | undefined;

  constructor(text: string, bom = false) {
    this.text = text;
    this.bom = bom;
    this.lineEnding = detectLineEnding(text);
  }

  /** Decodes UTF-8; keeps whether the file had a BOM. Invalid UTF-8 is replaced, never thrown. */
  static fromBytes(bytes: Uint8Array): SourceText {
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const text = new TextDecoder('utf-8').decode(bom ? bytes.subarray(3) : bytes);
    return new SourceText(text, bom);
  }

  toBytes(text: string = this.text): Uint8Array {
    const body = new TextEncoder().encode(text);
    if (!this.bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }

  /** The line break this file uses for new lines. */
  get newline(): string {
    return this.lineEnding === 'lf' ? '\n' : this.lineEnding === 'cr' ? '\r' : '\r\n';
  }

  private starts(): number[] {
    if (!this.lineStarts) {
      const starts = [0];
      const t = this.text;
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        if (c === 13) {
          if (t.charCodeAt(i + 1) === 10) i++;
          starts.push(i + 1);
        } else if (c === 10) {
          starts.push(i + 1);
        }
      }
      this.lineStarts = starts;
    }
    return this.lineStarts;
  }

  get lineCount(): number {
    return this.starts().length;
  }

  positionAt(offset: number): Position {
    const starts = this.starts();
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: clamped - starts[lo]! };
  }

  offsetAt(position: Position): number {
    const starts = this.starts();
    if (position.line >= starts.length) return this.text.length;
    if (position.line < 0) return 0;
    const start = starts[position.line]!;
    const end = this.lineEnd(position.line);
    return Math.min(start + Math.max(0, position.character), end);
  }

  lineStart(line: number): number {
    return this.starts()[line] ?? this.text.length;
  }

  /** Offset of the end of a line's content, before its line break. */
  lineEnd(line: number): number {
    const starts = this.starts();
    const next = starts[line + 1];
    if (next === undefined) return this.text.length;
    let end = next;
    if (this.text.charCodeAt(end - 1) === 10) end--;
    if (this.text.charCodeAt(end - 1) === 13) end--;
    return end;
  }

  lineText(line: number): string {
    return this.text.slice(this.lineStart(line), this.lineEnd(line));
  }

  slice(range: Range): string {
    return this.text.slice(range.start, range.end);
  }
}

function detectLineEnding(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (kinds === 0) return 'none';
  if (kinds > 1) return 'mixed';
  return crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'cr';
}
