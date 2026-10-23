// Edits on .s7res files: texts per culture, new entries, a new file. Ids are never renumbered;
// cultures stay in alphabetical order and values keep TIA's quoting (format-notes, finding 3).
import { quoteResourceValue, type ResourceEntry, type ResourceFile } from '../formats/s7res.ts';
import type { TextEdit } from '../writer/text-edit.ts';

export function resourceEntry(
  res: ResourceFile | undefined,
  id: string,
): ResourceEntry | undefined {
  return res?.entries.find((e) => e.id === id);
}

export function resourceText(
  res: ResourceFile | undefined,
  id: string | undefined,
  culture: string,
): string | undefined {
  if (!id) return undefined;
  return resourceEntry(res, id)?.values.find((v) => v.culture === culture)?.text;
}

/** Sets (or, with an empty text, removes) the text of one culture. Missing entries are added at the end. */
export function setResourceText(
  res: ResourceFile,
  id: string,
  culture: string,
  text: string,
): TextEdit[] {
  const nl = res.source.newline;
  const entry = resourceEntry(res, id);
  if (!entry) return text === '' ? [] : addResourceEntry(res, id, { [culture]: text });
  const existing = entry.values.find((v) => v.culture === culture);
  if (existing) {
    if (text === '') {
      const line = res.source.positionAt(existing.lineRange.start).line;
      const end =
        line + 1 < res.source.lineCount ? res.source.lineStart(line + 1) : res.source.text.length;
      return [{ start: existing.lineRange.start, end, newText: '' }];
    }
    return [
      {
        start: existing.valueRange.start,
        end: existing.valueRange.end,
        newText: quoteResourceValue(text),
      },
    ];
  }
  if (text === '') return [];
  const indent = entry.values[0]
    ? /^\s*/.exec(res.source.slice(entry.values[0].lineRange))![0]
    : '    ';
  const line = `${indent}${culture}: ${quoteResourceValue(text)}${nl}`;
  const next = entry.values.find((v) => v.culture > culture);
  if (next) return [{ start: next.lineRange.start, end: next.lineRange.start, newText: line }];
  const lastLineEnd =
    entry.values.length > 0
      ? entry.values[entry.values.length - 1]!.lineRange.end
      : entry.idRange.end;
  const insertAt = afterLineBreak(res, lastLineEnd);
  return [
    {
      start: insertAt,
      end: insertAt,
      newText: insertAt === res.source.text.length && !endsWithNewline(res) ? nl + line : line,
    },
  ];
}

/** Appends a new entry with its texts (cultures in alphabetical order). */
export function addResourceEntry(
  res: ResourceFile,
  id: string,
  values: Record<string, string>,
): TextEdit[] {
  const nl = res.source.newline;
  const text = entryText(id, values, nl);
  const end = res.source.text.length;
  if (res.source.text.trim() === '')
    return [{ start: 0, end, newText: `MultiLingualTexts:${nl}${text}` }];
  return [{ start: end, end, newText: (endsWithNewline(res) ? '' : nl) + text }];
}

export function removeResourceEntry(res: ResourceFile, id: string): TextEdit[] {
  const entry = resourceEntry(res, id);
  if (!entry) return [];
  const start = res.source.lineStart(res.source.positionAt(entry.range.start).line);
  return [{ start, end: afterLineBreak(res, entry.range.end), newText: '' }];
}

/** Text of a new .s7res file (CRLF, as TIA writes it). */
export function newResourceFileText(
  entries: readonly { id: string; values: Record<string, string> }[],
  nl = '\r\n',
): string {
  return `MultiLingualTexts:${nl}${entries.map((e) => entryText(e.id, e.values, nl)).join('')}`;
}

function entryText(id: string, values: Record<string, string>, nl: string): string {
  const lines = Object.keys(values)
    .filter((c) => values[c] !== '')
    .sort()
    .map((c) => `    ${c}: ${quoteResourceValue(values[c]!)}${nl}`);
  return `  - id: ${id}${nl}${lines.join('')}`;
}

function endsWithNewline(res: ResourceFile): boolean {
  return /[\r\n]$/.test(res.source.text);
}

function afterLineBreak(res: ResourceFile, offset: number): number {
  const line = res.source.positionAt(offset).line;
  return line + 1 < res.source.lineCount ? res.source.lineStart(line + 1) : res.source.text.length;
}
