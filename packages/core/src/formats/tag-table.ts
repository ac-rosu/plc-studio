// PLC tag tables in SimaticML (the only format TIA offers for them). VCI leaves out attributes
// at their default value, so defaults are applied here (format-notes, 2026-10-24).
import type { Range } from '../text/source-text.ts';
import { SourceText } from '../text/source-text.ts';
import type { SyntaxDiagnostic } from '../syntax/ast.ts';
import { attributeText, children, child, multilingual, parseXml, type XmlElement } from './xml.ts';

export interface TagTableEntry {
  readonly kind: 'tag' | 'constant' | 'systemConstant';
  readonly name: string;
  readonly nameRange: Range;
  readonly dataType: string;
  readonly dataTypeRange: Range | undefined;
  /** Tags: %I0.0 ... */
  readonly address: string | undefined;
  readonly addressRange: Range | undefined;
  /** Constants: the value as written. */
  readonly value: string | undefined;
  readonly valueRange: Range | undefined;
  readonly accessible: boolean;
  readonly visible: boolean;
  readonly writable: boolean;
  readonly retain: boolean | undefined;
  readonly comments: ReadonlyMap<string, { text: string; range: Range }>;
  readonly range: Range;
}

export interface TagTableFile {
  readonly kind: 'tagTable';
  readonly source: SourceText;
  readonly name: string;
  readonly published: boolean | undefined;
  readonly entries: TagTableEntry[];
  readonly diagnostics: SyntaxDiagnostic[];
  /** Range of the <ObjectList> holding the entries (for inserting new ones). */
  readonly objectListRange: Range | undefined;
}

function bool(element: XmlElement, name: string, fallback: boolean): boolean {
  const list = child(element, 'AttributeList');
  const direct = child(list, name)?.text;
  if (direct !== undefined) return direct.trim().toLowerCase() === 'true';
  const flagged = children(list, 'BooleanAttribute').find(
    (b) => b.attributes.get('Name')?.value === name,
  );
  if (flagged) return flagged.text.trim().toLowerCase() === 'true';
  return fallback;
}

export function parseTagTable(source: SourceText): TagTableFile {
  const diagnostics: SyntaxDiagnostic[] = [];
  const root = parseXml(source.text);
  const table = child(root, 'SW.Tags.PlcTagTable');
  if (!table) {
    diagnostics.push({
      range: { start: 0, end: Math.min(source.text.length, 200) },
      message: 'Not analyzed: this XML file is not a PLC tag table.',
      severity: 'info',
      code: 'not-analyzed',
    });
    return {
      kind: 'tagTable',
      source,
      name: '',
      published: undefined,
      entries: [],
      diagnostics,
      objectListRange: undefined,
    };
  }
  const access = attributeText(table, 'Access')?.text;
  const list = child(table, 'ObjectList');
  const entries: TagTableEntry[] = [];
  for (const e of list?.children ?? []) {
    const kind =
      e.name === 'SW.Tags.PlcTag'
        ? 'tag'
        : e.name === 'SW.Tags.PlcUserConstant'
          ? 'constant'
          : e.name === 'SW.Tags.PlcSystemConstant'
            ? 'systemConstant'
            : undefined;
    if (!kind) continue;
    const name = attributeText(e, 'Name');
    const dataType = attributeText(e, 'DataTypeName');
    const address = attributeText(e, 'LogicalAddress');
    const value = attributeText(e, 'Value');
    const retainText = attributeText(e, 'Retain')?.text;
    entries.push({
      kind,
      name: name?.text ?? '',
      nameRange: name?.textRange ?? e.range,
      dataType: dataType?.text ?? '',
      dataTypeRange: dataType?.textRange,
      address: address?.text,
      addressRange: address?.textRange,
      value: value?.text,
      valueRange: value?.textRange,
      accessible: bool(e, 'ExternalAccessible', true),
      visible: bool(e, 'ExternalVisible', true),
      writable: bool(e, 'ExternalWritable', true),
      retain: retainText === undefined ? undefined : retainText.toLowerCase() === 'true',
      comments: multilingual(e, 'Comment'),
      range: e.range,
    });
  }
  return {
    kind: 'tagTable',
    source,
    name: attributeText(table, 'Name')?.text ?? '',
    published: access === undefined ? undefined : access === 'Published',
    entries,
    diagnostics,
    objectListRange: list?.range,
  };
}

export function parseTagTableText(text: string): TagTableFile {
  return parseTagTable(new SourceText(text));
}
