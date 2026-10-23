// .s7res: the multilingual texts a SIMATIC SD document references by id (format-notes,
// finding 3). A YAML subset written by TIA:
//   MultiLingualTexts:
//     - id: MLC_4nB
//       de-DE: ...
//       en-US: ...
import type { Range } from '../text/source-text.ts';
import { SourceText } from '../text/source-text.ts';
import type { SyntaxDiagnostic } from '../syntax/ast.ts';

export interface ResourceValue {
  readonly culture: string;
  readonly text: string;
  /** The whole line, without its line break. */
  readonly lineRange: Range;
  /** The value as written (quotes included). */
  readonly valueRange: Range;
}

export interface ResourceEntry {
  readonly id: string;
  readonly idRange: Range;
  /** From the '- id:' line to the end of its last value line. */
  readonly range: Range;
  readonly values: ResourceValue[];
}

export interface ResourceFile {
  readonly kind: 'resources';
  readonly source: SourceText;
  readonly entries: ResourceEntry[];
  readonly diagnostics: SyntaxDiagnostic[];
}

export function parseResources(source: SourceText): ResourceFile {
  const entries: ResourceEntry[] = [];
  const diagnostics: SyntaxDiagnostic[] = [];
  let current: { id: string; idRange: Range; start: number; values: ResourceValue[] } | undefined;
  const flush = (end: number) => {
    if (current)
      entries.push({
        id: current.id,
        idRange: current.idRange,
        values: current.values,
        range: { start: current.start, end },
      });
    current = undefined;
  };
  let lastEnd = 0;
  for (let line = 0; line < source.lineCount; line++) {
    const start = source.lineStart(line);
    const end = source.lineEnd(line);
    const text = source.lineText(line);
    if (text.trim() === '') continue;
    if (line === 0 && text.trim() === 'MultiLingualTexts:') continue;
    const idMatch = /^(\s*)-\s+id:\s*(.*?)\s*$/.exec(text);
    if (idMatch) {
      flush(lastEnd);
      const idStart = start + text.indexOf(idMatch[2]!, idMatch[1]!.length + 1);
      current = {
        id: idMatch[2]!,
        idRange: { start: idStart, end: idStart + idMatch[2]!.length },
        start,
        values: [],
      };
      lastEnd = end;
      continue;
    }
    const valueMatch = /^(\s+)([A-Za-z]{2,3}-[A-Za-z]{2,4}):\s?(.*)$/.exec(text);
    if (valueMatch && current) {
      const valueText = valueMatch[3]!;
      const valueStart = end - valueText.length;
      current.values.push({
        culture: valueMatch[2]!,
        text: unquote(valueText),
        lineRange: { start, end },
        valueRange: { start: valueStart, end },
      });
      lastEnd = end;
      continue;
    }
    diagnostics.push({
      range: { start, end },
      message: 'Not analyzed: line in the resource file. The text is kept as it is.',
      severity: 'info',
      code: 'not-analyzed',
    });
  }
  flush(lastEnd);
  return { kind: 'resources', source, entries, diagnostics };
}

export function parseResourcesText(text: string): ResourceFile {
  return parseResources(new SourceText(text));
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** How TIA writes a value: single quotes when it contains ': ' or ' #' or could be misread. */
export function quoteResourceValue(text: string): string {
  const needsQuotes =
    text.includes(': ') ||
    text.includes(' #') ||
    text.endsWith(':') ||
    /^[\s'"&*!|>%@`{[#?-]/.test(text) ||
    /\s$/.test(text) ||
    text === '';
  return needsQuotes ? `'${text.replace(/'/g, "''")}'` : text;
}

/** Ids TIA creates look like MLC_ plus 2–3 alphanumerics; new ids never collide within a file. */
export function newResourceId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let n = 0; ; n++) {
    let id = '';
    let v = n;
    do {
      id = alphabet[v % alphabet.length]! + id;
      v = Math.floor(v / alphabet.length);
    } while (v > 0);
    const candidate = `MLC_P${id.padStart(2, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
}
