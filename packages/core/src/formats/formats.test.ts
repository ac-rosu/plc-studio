import { describe, expect, it } from 'vitest';
import { SourceText } from '../text/source-text.ts';
import { applyEdits, changedLines } from '../writer/text-edit.ts';
import { fileKindOf, parseSource, printFile } from './document.ts';
import { newResourceId, parseResourcesText, quoteResourceValue } from './s7res.ts';
import { parseTagTableText } from './tag-table.ts';

const RES = [
  'MultiLingualTexts:',
  '  - id: MLC_1',
  "    de-DE: 'Modus: 0 = aus'",
  '    en-US: Enable the evaluation',
  '  - id: MLC_2',
  "    en-US: Average of the 'valid' values",
  '',
].join('\r\n');

const TAGS = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Tags.PlcTagTable ID="0">
    <AttributeList>
      <Name>Tags_IO</Name>
    </AttributeList>
    <ObjectList>
      <SW.Tags.PlcTag ID="1" CompositionName="Tags">
        <AttributeList>
          <DataTypeName>Bool</DataTypeName>
          <ExternalWritable>false</ExternalWritable>
          <LogicalAddress>%I0.0</LogicalAddress>
          <Name>StartButton</Name>
        </AttributeList>
        <ObjectList>
          <MultilingualText ID="2" CompositionName="Comment">
            <ObjectList>
              <MultilingualTextItem ID="3" CompositionName="Items">
                <AttributeList>
                  <Culture>en-US</Culture>
                  <Text>Start &amp; go</Text>
                </AttributeList>
              </MultilingualTextItem>
            </ObjectList>
          </MultilingualText>
        </ObjectList>
      </SW.Tags.PlcTag>
      <SW.Tags.PlcUserConstant ID="4" CompositionName="UserConstants">
        <AttributeList>
          <DataTypeName>Int</DataTypeName>
          <Name>MAXIMUM_PIECES</Name>
          <Value>1000</Value>
        </AttributeList>
      </SW.Tags.PlcUserConstant>
    </ObjectList>
  </SW.Tags.PlcTagTable>
</Document>`;

describe('.s7res', () => {
  it('reads ids, cultures and quoted values', () => {
    const res = parseResourcesText(RES);
    expect(res.diagnostics).toEqual([]);
    expect(res.entries.map((e) => e.id)).toEqual(['MLC_1', 'MLC_2']);
    expect(res.entries[0]!.values.map((v) => [v.culture, v.text])).toEqual([
      ['de-DE', 'Modus: 0 = aus'],
      ['en-US', 'Enable the evaluation'],
    ]);
    expect(res.entries[1]!.values[0]!.text).toBe("Average of the 'valid' values");
  });

  it('quotes values the way TIA does', () => {
    expect(quoteResourceValue('Mode: 0 = off')).toBe("'Mode: 0 = off'");
    expect(quoteResourceValue('Steps # done')).toBe("'Steps # done'");
    expect(quoteResourceValue('Measured values & limits')).toBe('Measured values & limits');
    expect(quoteResourceValue("it's: x")).toBe("'it''s: x'");
  });

  it('creates ids that do not collide', () => {
    const id = newResourceId(['MLC_P00', 'MLC_P01']);
    expect(id).toMatch(/^MLC_/);
    expect(['MLC_P00', 'MLC_P01']).not.toContain(id);
  });
});

describe('tag tables', () => {
  it('reads tags, constants, defaults and comments', () => {
    const table = parseTagTableText(TAGS);
    expect(table.name).toBe('Tags_IO');
    const [tag, constant] = table.entries;
    expect([tag!.kind, tag!.name, tag!.dataType, tag!.address]).toEqual([
      'tag',
      'StartButton',
      'Bool',
      '%I0.0',
    ]);
    expect([tag!.accessible, tag!.visible, tag!.writable]).toEqual([true, true, false]);
    expect(tag!.comments.get('en-US')?.text).toBe('Start & go');
    expect(TAGS.slice(tag!.nameRange.start, tag!.nameRange.end)).toBe('StartButton');
    expect([constant!.kind, constant!.value]).toEqual(['constant', '1000']);
  });
});

describe('documents and edits', () => {
  it('chooses the parser by file name', () => {
    expect(
      [
        'a.s7dcl',
        'a.s7res',
        'a.scl',
        'a.udt',
        'a.db',
        'a.xml',
        'plc.json',
        'x/plcstudio.rules.json',
      ].map(fileKindOf),
    ).toEqual(['s7dcl', 's7res', 'source', 'source', 'source', 'tagTable', 'manifest', 'rules']);
  });

  it('prints unchanged files byte for byte, BOM included', () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(
        'TYPE "U"\r\nSTRUCT\r\n a : Int;\r\nEND_STRUCT;\r\nEND_TYPE\r\n\r\n',
      ),
    ]);
    const source = SourceText.fromBytes(bytes);
    const parsed = parseSource('U.udt', source)!;
    expect(parsed.diagnostics).toEqual([]);
    expect(source.toBytes(printFile(parsed))).toEqual(bytes);
    expect(source.lineEnding).toBe('crlf');
  });

  it('applies edits and reports only the lines they touched', () => {
    const text = 'a\r\nb\r\nc\r\n';
    const after = applyEdits(text, [{ start: 3, end: 4, newText: 'B' }]);
    expect(after).toBe('a\r\nB\r\nc\r\n');
    expect(changedLines(text, after)).toEqual([1]);
    expect(() =>
      applyEdits(text, [
        { start: 0, end: 2, newText: '' },
        { start: 1, end: 3, newText: '' },
      ]),
    ).toThrow();
  });
});
