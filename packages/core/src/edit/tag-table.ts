// Edits on SimaticML tag tables (spec, "Tag table editor"): only the elements that change are
// rewritten, in the layout TIA writes (attributes in alphabetical order, defaults left out as VCI
// does, element IDs counting up through the document).
import type { CpuFamily } from '@plcstudio/profiles';
import { parseTagTableText, type TagTableEntry, type TagTableFile } from '../formats/tag-table.ts';
import {
  attributeText,
  child,
  children,
  encodeEntities,
  parseXml,
  type XmlElement,
} from '../formats/xml.ts';
import type { Range } from '../text/source-text.ts';
import { applyEdits, type TextEdit } from '../writer/text-edit.ts';
import {
  failed,
  indentOf,
  lineDiffEdits,
  lineSpan,
  lineStartOf,
  type EditResult,
} from './common.ts';

export type TagFlag = 'ExternalAccessible' | 'ExternalVisible' | 'ExternalWritable';

function entryElement(table: TagTableFile, entry: TagTableEntry): XmlElement | undefined {
  const root = parseXml(table.source.text);
  const list = child(child(root, 'SW.Tags.PlcTagTable'), 'ObjectList');
  return list?.children.find((c) => c.range.start === entry.range.start);
}

export function findEntry(table: TagTableFile, name: string): TagTableEntry | undefined {
  return table.entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
}

function maxId(text: string): number {
  let max = -1;
  for (const m of text.matchAll(/\bID="(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Replaces the text of an attribute element, inserting it in alphabetical order when missing. */
function setAttributeElement(
  table: TagTableFile,
  element: XmlElement,
  name: string,
  value: string | undefined,
): TextEdit[] {
  const source = table.source;
  const list = child(element, 'AttributeList');
  if (!list) return [];
  const existing = child(list, name);
  if (existing) {
    if (value === undefined) {
      const span = lineSpan(source, existing.range);
      return [{ start: span.start, end: span.end, newText: '' }];
    }
    return [
      {
        start: existing.textRange.start,
        end: existing.textRange.end,
        newText: encodeEntities(value),
      },
    ];
  }
  if (value === undefined) return [];
  const siblings = list.children;
  const indent = siblings[0]
    ? indentOf(source, siblings[0].range.start)
    : indentOf(source, list.range.start) + '  ';
  const line = `${indent}<${name}>${encodeEntities(value)}</${name}>${source.newline}`;
  const next = siblings.find((s) => s.name > name);
  const at = next
    ? lineStartOf(source, next.range.start)
    : lineStartOf(source, list.range.end - '</AttributeList>'.length);
  return [{ start: at, end: at, newText: line }];
}

export function renameEntryText(
  table: TagTableFile,
  entry: TagTableEntry,
  newName: string,
): TextEdit[] {
  return [
    { start: entry.nameRange.start, end: entry.nameRange.end, newText: encodeEntities(newName) },
  ];
}

export function setEntryDataType(
  table: TagTableFile,
  entry: TagTableEntry,
  dataType: string,
): EditResult {
  if (entry.kind === 'systemConstant') return failed('System constants are read-only.');
  if (!dataType.trim()) return failed('A data type is needed.');
  if (!entry.dataTypeRange) return failed('The tag has no data type element.');
  return {
    edits: [
      {
        start: entry.dataTypeRange.start,
        end: entry.dataTypeRange.end,
        newText: encodeEntities(dataType.trim()),
      },
    ],
  };
}

export function setEntryAddress(
  table: TagTableFile,
  entry: TagTableEntry,
  address: string,
): EditResult {
  if (entry.kind !== 'tag') return failed('Only tags have an address.');
  const element = entryElement(table, entry);
  if (!element) return failed('Tag not found.');
  return {
    edits: setAttributeElement(
      table,
      element,
      'LogicalAddress',
      address.trim().toUpperCase().replace(/^%?/, '%'),
    ),
  };
}

export function setConstantValue(
  table: TagTableFile,
  entry: TagTableEntry,
  value: string,
): EditResult {
  if (entry.kind !== 'constant')
    return failed(
      entry.kind === 'systemConstant'
        ? 'System constants are read-only.'
        : 'Only constants have a value.',
    );
  const element = entryElement(table, entry);
  if (!element) return failed('Constant not found.');
  return { edits: setAttributeElement(table, element, 'Value', value.trim()) };
}

/** Accessible/visible/writable from HMI/OPC UA; true is the default and is left out (VCI style). */
export function setEntryFlag(
  table: TagTableFile,
  entry: TagTableEntry,
  flag: TagFlag,
  value: boolean,
): EditResult {
  if (entry.kind === 'systemConstant') return failed('System constants are read-only.');
  const element = entryElement(table, entry);
  if (!element) return failed('Tag not found.');
  const edits: TextEdit[] = [];
  const set = (f: TagFlag, v: boolean) => {
    const existing = child(child(element, 'AttributeList'), f);
    if (existing) edits.push(...setAttributeElement(table, element, f, v ? 'true' : 'false'));
    else if (!v) edits.push(...setAttributeElement(table, element, f, 'false'));
  };
  set(flag, value);
  // not accessible means neither visible nor writable. VCI then leaves both out, an Openness
  // export writes them false (C04): rewrite them only where the file states them.
  if (flag === 'ExternalAccessible' && !value) {
    const attributes = child(element, 'AttributeList');
    if (entry.visible && child(attributes, 'ExternalVisible')) set('ExternalVisible', false);
    if (entry.writable && child(attributes, 'ExternalWritable')) set('ExternalWritable', false);
  }
  return { edits: mergeInsertions(edits) };
}

/** Several insertions at one offset become one edit, in order. */
function mergeInsertions(edits: TextEdit[]): TextEdit[] {
  const out: TextEdit[] = [];
  for (const e of edits) {
    const same = out.find(
      (o) => o.start === e.start && o.end === e.end && o.start === o.end && e.start === e.end,
    );
    if (same) out[out.indexOf(same)] = { ...same, newText: same.newText + e.newText };
    else out.push(e);
  }
  return out;
}

/** Sets the comment of one culture (an empty text removes it). */
export function setEntryComment(
  table: TagTableFile,
  entry: TagTableEntry,
  culture: string,
  text: string,
): EditResult {
  const element = entryElement(table, entry);
  if (!element) return failed('Tag not found.');
  const source = table.source;
  const nl = source.newline;
  const existing = entry.comments.get(culture);
  if (existing) {
    if (text === '') {
      const item = itemFor(element, culture);
      if (!item) return { edits: [] };
      const span = lineSpan(source, item.range);
      return { edits: [{ start: span.start, end: span.end, newText: '' }] };
    }
    return {
      edits: [
        { start: existing.range.start, end: existing.range.end, newText: encodeEntities(text) },
      ],
    };
  }
  if (text === '') return { edits: [] };
  let id = maxId(source.text) + 1;
  const objectList = child(element, 'ObjectList');
  const comment = children(objectList, 'MultilingualText').find(
    (t) => t.attributes.get('CompositionName')?.value === 'Comment',
  );
  const entryIndent = indentOf(source, element.range.start);
  const step = '  ';
  const item = (indent: string) =>
    `${indent}<MultilingualTextItem ID="${id++}" CompositionName="Items">${nl}${indent}${step}<AttributeList>${nl}${indent}${step}${step}<Culture>${encodeEntities(culture)}</Culture>${nl}${indent}${step}${step}<Text>${encodeEntities(text)}</Text>${nl}${indent}${step}</AttributeList>${nl}${indent}</MultilingualTextItem>${nl}`;
  if (comment) {
    const itemsList = child(comment, 'ObjectList');
    const items = children(itemsList, 'MultilingualTextItem');
    const indent = items[0]
      ? indentOf(source, items[0].range.start)
      : indentOf(source, comment.range.start) + step + step;
    const next = items.find((it) => (attributeText(it, 'Culture')?.text ?? '') > culture);
    const at = next
      ? lineStartOf(source, next.range.start)
      : lineStartOf(
          source,
          (itemsList ?? comment).range.end -
            (itemsList ? '</ObjectList>'.length : '</MultilingualText>'.length),
        );
    return { edits: [{ start: at, end: at, newText: item(indent) }] };
  }
  const i1 = entryIndent + step;
  const i2 = i1 + step;
  const i3 = i2 + step;
  const commentId = id++;
  const block = `${i2}<MultilingualText ID="${commentId}" CompositionName="Comment">${nl}${i3}<ObjectList>${nl}${item(i3 + step)}${i3}</ObjectList>${nl}${i2}</MultilingualText>${nl}`;
  if (objectList) {
    const at = lineStartOf(source, objectList.range.end - '</ObjectList>'.length);
    return { edits: [{ start: at, end: at, newText: block }] };
  }
  const at = lineStartOf(source, element.range.end - `</${element.name}>`.length);
  return {
    edits: [
      { start: at, end: at, newText: `${i1}<ObjectList>${nl}${block}${i1}</ObjectList>${nl}` },
    ],
  };
}

function itemFor(element: XmlElement, culture: string): XmlElement | undefined {
  const comment = children(child(element, 'ObjectList'), 'MultilingualText').find(
    (t) => t.attributes.get('CompositionName')?.value === 'Comment',
  );
  return children(child(comment, 'ObjectList'), 'MultilingualTextItem').find(
    (it) => attributeText(it, 'Culture')?.text === culture,
  );
}

export interface NewEntry {
  readonly kind: 'tag' | 'constant';
  readonly name: string;
  readonly dataType: string;
  /** Tags: logical address; constants: value. */
  readonly addressOrValue: string;
  readonly comments?: Readonly<Record<string, string>>;
}

/** Adds a tag (after the last tag) or a user constant (after the last constant). */
export function addEntry(table: TagTableFile, spec: NewEntry): EditResult {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.name))
    return failed(`${spec.name} is not a valid name.`);
  if (findEntry(table, spec.name)) return failed(`${spec.name} already exists in this tag table.`);
  const source = table.source;
  const nl = source.newline;
  const root = parseXml(source.text);
  const list = child(child(root, 'SW.Tags.PlcTagTable'), 'ObjectList');
  if (!list) return failed('This tag table has no list of tags.');
  const elementName = spec.kind === 'tag' ? 'SW.Tags.PlcTag' : 'SW.Tags.PlcUserConstant';
  const composition = spec.kind === 'tag' ? 'Tags' : 'UserConstants';
  const same = list.children.filter((c) => c.name === elementName);
  const any = list.children[0];
  const indent = any
    ? indentOf(source, any.range.start)
    : indentOf(source, list.range.start) + '  ';
  const step = '  ';
  let id = maxId(source.text) + 1;
  const attrs: [string, string][] = [['DataTypeName', spec.dataType.trim()]];
  if (spec.kind === 'tag') attrs.push(['LogicalAddress', spec.addressOrValue.trim()]);
  attrs.push(['Name', spec.name]);
  if (spec.kind === 'constant') attrs.push(['Value', spec.addressOrValue.trim()]);
  attrs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const a1 = indent + step;
  const a2 = a1 + step;
  let text = `${indent}<${elementName} ID="${id++}" CompositionName="${composition}">${nl}${a1}<AttributeList>${nl}`;
  text += attrs.map(([n, v]) => `${a2}<${n}>${encodeEntities(v)}</${n}>${nl}`).join('');
  text += `${a1}</AttributeList>${nl}`;
  const comments = Object.entries(spec.comments ?? {})
    .filter(([, v]) => v !== '')
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (comments.length > 0) {
    const a3 = a2 + step;
    const a4 = a3 + step;
    text += `${a1}<ObjectList>${nl}${a2}<MultilingualText ID="${id++}" CompositionName="Comment">${nl}${a3}<ObjectList>${nl}`;
    for (const [culture, comment] of comments) {
      text += `${a4}<MultilingualTextItem ID="${id++}" CompositionName="Items">${nl}${a4}${step}<AttributeList>${nl}${a4}${step}${step}<Culture>${encodeEntities(culture)}</Culture>${nl}${a4}${step}${step}<Text>${encodeEntities(comment)}</Text>${nl}${a4}${step}</AttributeList>${nl}${a4}</MultilingualTextItem>${nl}`;
    }
    text += `${a3}</ObjectList>${nl}${a2}</MultilingualText>${nl}${a1}</ObjectList>${nl}`;
  }
  text += `${indent}</${elementName}>${nl}`;
  let at: number;
  if (same.length > 0) at = lineSpan(source, same[same.length - 1]!.range).end;
  else if (spec.kind === 'tag' && list.children.length > 0)
    at = lineStartOf(source, list.children[0]!.range.start);
  else at = lineStartOf(source, list.range.end - '</ObjectList>'.length);
  return { edits: [{ start: at, end: at, newText: text }] };
}

export function deleteEntry(table: TagTableFile, entry: TagTableEntry): EditResult {
  if (entry.kind === 'systemConstant') return failed('System constants are read-only.');
  const span = lineSpan(table.source, entry.range);
  return { edits: [{ start: span.start, end: span.end, newText: '' }] };
}

// --- Addresses -------------------------------------------------------------------------------

export interface ParsedAddress {
  readonly area: 'I' | 'Q' | 'M';
  /** X bit, B byte, W word, D double word, L long word */
  readonly size: 'X' | 'B' | 'W' | 'D' | 'L';
  readonly byte: number;
  readonly bit: number;
  /** Peripheral access (:P). */
  readonly peripheral: boolean;
}

export function parseAddress(address: string): ParsedAddress | undefined {
  const m = /^%([IQM])([XBWDL]?)(\d+)(?:\.(\d))?(:P)?$/i.exec(address.trim());
  if (!m) return undefined;
  const area = m[1]!.toUpperCase() as ParsedAddress['area'];
  const explicit = m[2]!.toUpperCase();
  const byte = Number(m[3]);
  const bit = m[4] !== undefined ? Number(m[4]) : -1;
  const size = (explicit || (bit >= 0 ? 'X' : '')) as ParsedAddress['size'] | '';
  if (!size) return undefined;
  if (size === 'X' && (bit < 0 || bit > 7)) return undefined;
  if (size !== 'X' && bit >= 0) return undefined;
  return { area, size, byte, bit: size === 'X' ? bit : 0, peripheral: m[5] !== undefined };
}

const SIZE_BYTES: Record<ParsedAddress['size'], number> = { X: 1, B: 1, W: 2, D: 4, L: 8 };

/** Size an elementary data type needs in an address, or undefined when TIA allows other choices. */
function sizeFor(dataType: string): ParsedAddress['size'] | undefined {
  const t = dataType.toLowerCase();
  if (t === 'bool') return 'X';
  if (['byte', 'sint', 'usint', 'char'].includes(t)) return 'B';
  if (['word', 'int', 'uint', 'date', 'wchar', 's5time'].includes(t)) return 'W';
  if (['dword', 'dint', 'udint', 'real', 'time', 'time_of_day', 'tod'].includes(t)) return 'D';
  if (['lword', 'lint', 'ulint', 'lreal', 'ltime', 'ltime_of_day', 'ltod'].includes(t)) return 'L';
  return undefined;
}

/** Bit-memory and process-image sizes per CPU family, in bytes (upper bounds of the family). */
const AREA_LIMITS: Record<CpuFamily, Record<ParsedAddress['area'], number>> = {
  'S7-1200': { I: 1024, Q: 1024, M: 8192 },
  'S7-1500': { I: 32768, Q: 32768, M: 16384 },
};

export interface AddressProblem {
  readonly entry: TagTableEntry;
  readonly range: Range;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
}

/** Address validity per CPU family and overlaps between tags of the given tables. */
export function addressProblems(
  tables: readonly TagTableFile[],
  family: CpuFamily | undefined,
): AddressProblem[] {
  const out: AddressProblem[] = [];
  const placed: { entry: TagTableEntry; area: string; start: number; end: number; bit: number }[] =
    [];
  for (const table of tables) {
    for (const entry of table.entries) {
      if (entry.kind !== 'tag' || !entry.address) continue;
      const range = entry.addressRange ?? entry.nameRange;
      const a = parseAddress(entry.address);
      if (!a) {
        out.push({
          entry,
          range,
          severity: 'warning',
          message: `${entry.address} is not an input, output or bit-memory address.`,
        });
        continue;
      }
      const need = sizeFor(entry.dataType);
      if (need && need !== a.size) {
        out.push({
          entry,
          range,
          severity: 'warning',
          message: `${entry.dataType} needs a ${sizeName(need)} address, not ${entry.address}.`,
        });
      }
      if (a.size === 'L' && family === 'S7-1200') {
        out.push({
          entry,
          range,
          severity: 'warning',
          message: `64-bit addresses do not exist on S7-1200.`,
        });
      }
      const limit = family ? AREA_LIMITS[family][a.area] : undefined;
      if (limit !== undefined && a.byte + SIZE_BYTES[a.size] > limit) {
        out.push({
          entry,
          range,
          severity: 'warning',
          message: `${entry.address} lies beyond the ${a.area} area of an ${family} CPU (at most ${limit} bytes).`,
        });
      }
      placed.push({
        entry,
        area: a.area + (a.peripheral ? 'P' : ''),
        start: a.byte,
        end: a.byte + SIZE_BYTES[a.size],
        bit: a.size === 'X' ? a.bit : -1,
      });
    }
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const p = placed[i]!;
      const q = placed[j]!;
      if (p.area !== q.area || p.end <= q.start || q.end <= p.start) continue;
      if (p.bit >= 0 && q.bit >= 0 && p.bit !== q.bit) continue;
      out.push({
        entry: q.entry,
        range: q.entry.addressRange ?? q.entry.nameRange,
        severity: 'info',
        message: `${q.entry.address} (${q.entry.name}) overlaps ${p.entry.address} (${p.entry.name}).`,
      });
    }
  }
  return out;
}

function sizeName(size: ParsedAddress['size']): string {
  return { X: 'bit', B: 'byte', W: 'word', D: 'double-word', L: 'long-word' }[size];
}

// --- CSV ---------------------------------------------------------------------------------------

const CSV_FIXED = [
  'Kind',
  'Name',
  'DataType',
  'Address',
  'Value',
  'Accessible',
  'Visible',
  'Writable',
];

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Comments are free text from the file: one starting like a formula (= + - @) gets a leading
 * apostrophe, so a spreadsheet shows it as text instead of evaluating it. Import removes it.
 */
const FORMULA_START = /^[=+\-@]/;
const guardComment = (text: string) => (FORMULA_START.test(text) ? `'${text}` : text);
const unguardComment = (text: string) =>
  text.startsWith("'") && FORMULA_START.test(text.slice(1)) ? text.slice(1) : text;

/** One row per tag or constant; one "Comment <culture>" column per language. */
export function exportCsv(table: TagTableFile): string {
  const cultures = [...new Set(table.entries.flatMap((e) => [...e.comments.keys()]))].sort();
  const header = [...CSV_FIXED, ...cultures.map((c) => `Comment ${c}`)];
  const rows = table.entries.map((e) => [
    e.kind === 'tag' ? 'Tag' : e.kind === 'constant' ? 'Constant' : 'SystemConstant',
    e.name,
    e.dataType,
    e.address ?? '',
    e.value ?? '',
    String(e.accessible),
    String(e.visible),
    String(e.writable),
    ...cultures.map((c) => guardComment(e.comments.get(c)?.text ?? '')),
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    if (row.some((x) => x !== '')) rows.push(row);
  }
  return rows;
}

/**
 * Applies a CSV to a tag table: changed fields of existing entries are edited, new names are
 * added. Rows are never deleted by an import. Returns one EditResult per change, applied in order
 * by re-parsing between steps (the caller does that), or the first problem.
 */
export function csvChanges(
  table: TagTableFile,
  csv: string,
): { changes: CsvChange[]; problems: string[] } {
  const rows = parseCsv(csv);
  const problems: string[] = [];
  const changes: CsvChange[] = [];
  const header = rows.shift();
  if (!header) return { changes, problems: ['The file is empty.'] };
  const col = (name: string) =>
    header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const idx = Object.fromEntries(CSV_FIXED.map((h) => [h, col(h)]));
  if (idx['Name']! < 0) return { changes, problems: ['The CSV needs a Name column.'] };
  const cultureCols = header
    .map((h, i) => [h, i] as const)
    .filter(([h]) => /^Comment /i.test(h))
    .map(([h, i]) => [h.slice(8).trim(), i] as const);
  rows.forEach((r, n) => {
    const get = (name: string) => (idx[name]! >= 0 ? (r[idx[name]!] ?? '').trim() : undefined);
    const name = get('Name') ?? '';
    if (!name) {
      problems.push(`Row ${n + 2}: no name.`);
      return;
    }
    const kindText = (get('Kind') ?? 'Tag').toLowerCase();
    if (kindText === 'systemconstant') return;
    const kind = kindText === 'constant' ? 'constant' : 'tag';
    const comments = Object.fromEntries(
      cultureCols.map(([c, i]) => [c, unguardComment((r[i] ?? '').trim())]),
    );
    changes.push({
      kind,
      name,
      dataType: get('DataType'),
      address: get('Address'),
      value: get('Value'),
      accessible: parseBool(get('Accessible')),
      visible: parseBool(get('Visible')),
      writable: parseBool(get('Writable')),
      comments,
    });
  });
  void table;
  return { changes, problems };
}

export interface CsvChange {
  readonly kind: 'tag' | 'constant';
  readonly name: string;
  readonly dataType: string | undefined;
  readonly address: string | undefined;
  readonly value: string | undefined;
  readonly accessible: boolean | undefined;
  readonly visible: boolean | undefined;
  readonly writable: boolean | undefined;
  readonly comments: Readonly<Record<string, string>>;
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  return /^(true|yes|1|x)$/i.test(v);
}

/** The next edit that brings the table closer to one CSV change, or undefined when it matches. */
export function nextCsvEdit(table: TagTableFile, change: CsvChange): EditResult | undefined {
  const entry = findEntry(table, change.name);
  if (!entry) {
    return addEntry(table, {
      kind: change.kind,
      name: change.name,
      dataType: change.dataType ?? 'Bool',
      addressOrValue: (change.kind === 'tag' ? change.address : change.value) ?? '',
      comments: change.comments,
    });
  }
  if (change.dataType !== undefined && change.dataType !== '' && change.dataType !== entry.dataType)
    return setEntryDataType(table, entry, change.dataType);
  if (
    entry.kind === 'tag' &&
    change.address &&
    change.address.toUpperCase() !== (entry.address ?? '').toUpperCase()
  )
    return setEntryAddress(table, entry, change.address);
  if (
    entry.kind === 'constant' &&
    change.value !== undefined &&
    change.value !== '' &&
    change.value !== entry.value
  )
    return setConstantValue(table, entry, change.value);
  for (const [flag, value] of [
    ['ExternalAccessible', change.accessible],
    ['ExternalVisible', change.visible],
    ['ExternalWritable', change.writable],
  ] as const) {
    const current =
      flag === 'ExternalAccessible'
        ? entry.accessible
        : flag === 'ExternalVisible'
          ? entry.visible
          : entry.writable;
    if (value !== undefined && value !== current) return setEntryFlag(table, entry, flag, value);
  }
  for (const [culture, text] of Object.entries(change.comments)) {
    if ((entry.comments.get(culture)?.text ?? '') !== text)
      return setEntryComment(table, entry, culture, text);
  }
  return undefined;
}

export interface CsvImport {
  /** Minimal edits on the tag table text for every change of the CSV together (one undo step). */
  readonly edits: readonly TextEdit[];
  /** How many single changes were made. */
  readonly applied: number;
  /** Rows that were skipped. */
  readonly problems: readonly string[];
  /** The change that could not be made; the edits hold the changes before it. */
  readonly error?: string;
}

/**
 * Applies a whole CSV to a tag table text: each change is computed on the result of the previous
 * one (so every step is a minimal edit), and the steps are returned as one set of line edits.
 */
export function csvImport(text: string, csv: string): CsvImport {
  const problems = csvChanges(parseTagTableText(text), csv).problems;
  let current = text;
  let applied = 0;
  let error: string | undefined;
  for (let guard = 0; guard < 5000; guard++) {
    const table = parseTagTableText(current);
    let next: EditResult | undefined;
    for (const change of csvChanges(table, csv).changes) {
      next = nextCsvEdit(table, change);
      if (next) break;
    }
    if (!next) break;
    if (next.error) {
      error = next.error;
      break;
    }
    current = applyEdits(current, next.edits);
    applied++;
  }
  const edits = lineDiffEdits(text, current);
  return error === undefined ? { edits, applied, problems } : { edits, applied, problems, error };
}
