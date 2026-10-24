// Reads a SimaticML block or PLC data type (ADR 0014): what the read-only views need, taken from
// the XML itself. Elements are matched by their local names, so every schema version reads the
// same way (V20 and V21 differ in namespace versions only).
import { child, children, parseXml, type XmlElement } from '../formats/xml.ts';

export type SimaticmlBlockKind = 'FB' | 'FC' | 'OB' | 'GlobalDB' | 'InstanceDB' | 'ArrayDB' | 'UDT';

/** Texts by culture, for example { 'en-US': 'Start', 'de-DE': 'Start' }. */
export type SimaticmlTexts = Readonly<Record<string, string>>;

export interface SimaticmlMember {
  readonly name: string;
  /** As the XML writes it, for example `Array[0..2] of "UDT_Point"`. */
  readonly datatype: string;
  readonly startValue: string | undefined;
  /** Start values of array elements: path "1" or "1,2" (indexes) and value. */
  readonly elements: readonly { readonly path: string; readonly value: string }[];
  readonly comment: SimaticmlTexts;
  /** Retain, NonRetain or SetInIDB; undefined where the XML leaves it out. */
  readonly remanence: string | undefined;
  readonly accessible: boolean | undefined;
  readonly visible: boolean | undefined;
  readonly writable: boolean | undefined;
  readonly setpoint: boolean | undefined;
  /** Members of a struct, of a PLC data type or of an array's element type. */
  readonly members: readonly SimaticmlMember[];
}

export interface SimaticmlSection {
  /** Input, Output, InOut, Static, Temp, Constant, Return; None for a PLC data type. */
  readonly name: string;
  readonly members: readonly SimaticmlMember[];
}

export interface SimaticmlNetwork {
  /** 1-based, as TIA numbers networks. */
  readonly index: number;
  /** LAD, FBD, SCL, STL, F_LAD ... */
  readonly language: string;
  readonly title: SimaticmlTexts;
  readonly comment: SimaticmlTexts;
  /** FlgNet (LAD/FBD) or StructuredText (SCL); undefined for an empty network. */
  readonly source: XmlElement | undefined;
}

export interface SimaticmlBlock {
  readonly kind: SimaticmlBlockKind;
  readonly name: string;
  readonly namespace: string | undefined;
  readonly number: number | undefined;
  /** ProgrammingLanguage (SCL, LAD, F_FBD, DB ...); empty for a PLC data type. */
  readonly language: string;
  /** The Engineering version of the document, for example V21. */
  readonly version: string | undefined;
  readonly failsafe: boolean;
  readonly iecCheck: boolean | undefined;
  readonly optimized: boolean | undefined;
  /** Instance DB: the FB it belongs to. */
  readonly instanceOf: string | undefined;
  readonly sections: readonly SimaticmlSection[];
  readonly networks: readonly SimaticmlNetwork[];
  readonly title: SimaticmlTexts;
  readonly comment: SimaticmlTexts;
}

const KINDS: Readonly<Record<string, SimaticmlBlockKind>> = {
  'SW.Blocks.FB': 'FB',
  'SW.Blocks.FC': 'FC',
  'SW.Blocks.OB': 'OB',
  'SW.Blocks.GlobalDB': 'GlobalDB',
  'SW.Blocks.InstanceDB': 'InstanceDB',
  'SW.Blocks.ArrayDB': 'ArrayDB',
  'SW.Types.PlcStruct': 'UDT',
};

/** Whether the text is a SimaticML export of a block or PLC data type (cheap, no full parse). */
export function isSimaticmlBlock(text: string): boolean {
  return (
    /<Document\b/.test(text.slice(0, 2000)) && /<SW\.(Blocks\.\w+|Types\.PlcStruct)\b/.test(text)
  );
}

export function readSimaticmlBlock(text: string): SimaticmlBlock | undefined {
  const document = parseXml(text);
  if (document?.name !== 'Document') return undefined;
  const element = document.children.find((e) => KINDS[e.name] !== undefined);
  if (!element) return undefined;
  const kind = KINDS[element.name]!;
  const attributes = child(element, 'AttributeList');
  const value = (name: string) => child(attributes, name)?.text;
  const flag = (name: string) => {
    const v = value(name);
    return v === undefined ? undefined : v === 'true';
  };
  const language = value('ProgrammingLanguage') ?? '';
  const number = value('Number');
  const objects = child(element, 'ObjectList');
  return {
    kind,
    name: value('Name') ?? '',
    namespace: value('Namespace') || undefined,
    number: number ? Number(number) : undefined,
    language,
    version: child(document, 'Engineering')?.attributes.get('version')?.value,
    failsafe: language.startsWith('F_'),
    iecCheck: flag('IsIECCheckEnabled'),
    optimized:
      value('MemoryLayout') === undefined ? undefined : value('MemoryLayout') === 'Optimized',
    instanceOf: value('InstanceOfName') || undefined,
    sections: children(child(child(attributes, 'Interface'), 'Sections'), 'Section').map((s) => ({
      name: s.attributes.get('Name')?.value ?? '',
      members: children(s, 'Member').map(member),
    })),
    networks: children(objects, 'SW.Blocks.CompileUnit').map((unit, i) => network(unit, i + 1)),
    title: compositionTexts(objects, 'Title'),
    comment: compositionTexts(objects, 'Comment'),
  };
}

function member(m: XmlElement): SimaticmlMember {
  const bools = new Map(
    children(child(m, 'AttributeList'), 'BooleanAttribute').map((a) => [
      a.attributes.get('Name')?.value ?? '',
      a.text === 'true',
    ]),
  );
  return {
    name: m.attributes.get('Name')?.value ?? '',
    datatype: m.attributes.get('Datatype')?.value ?? '',
    startValue: child(m, 'StartValue')?.text,
    elements: children(m, 'Subelement').flatMap((s) => {
      const v = child(s, 'StartValue')?.text;
      return v === undefined ? [] : [{ path: s.attributes.get('Path')?.value ?? '', value: v }];
    }),
    comment: languageTexts(child(m, 'Comment')),
    remanence: m.attributes.get('Remanence')?.value,
    accessible: bools.get('ExternalAccessible'),
    visible: bools.get('ExternalVisible'),
    writable: bools.get('ExternalWritable'),
    setpoint: bools.get('SetPoint'),
    members: [
      ...children(m, 'Member'),
      ...children(child(m, 'Sections'), 'Section').flatMap((s) => children(s, 'Member')),
    ].map(member),
  };
}

function network(unit: XmlElement, index: number): SimaticmlNetwork {
  const attributes = child(unit, 'AttributeList');
  const source = child(attributes, 'NetworkSource')?.children[0];
  return {
    index,
    language: child(attributes, 'ProgrammingLanguage')?.text ?? '',
    title: compositionTexts(child(unit, 'ObjectList'), 'Title'),
    comment: compositionTexts(child(unit, 'ObjectList'), 'Comment'),
    source,
  };
}

/** <Comment><MultiLanguageText Lang="en-US">…</MultiLanguageText>… (interface members). */
function languageTexts(element: XmlElement | undefined): SimaticmlTexts {
  const out: Record<string, string> = {};
  for (const t of children(element, 'MultiLanguageText')) {
    const lang = t.attributes.get('Lang')?.value;
    if (lang && t.text) out[lang] = t.text;
  }
  return out;
}

/** <MultilingualText CompositionName="Title"> with one item per culture (blocks, networks). */
function compositionTexts(objects: XmlElement | undefined, composition: string): SimaticmlTexts {
  const text = children(objects, 'MultilingualText').find(
    (t) => t.attributes.get('CompositionName')?.value === composition,
  );
  const out: Record<string, string> = {};
  for (const item of children(child(text, 'ObjectList'), 'MultilingualTextItem')) {
    const list = child(item, 'AttributeList');
    const culture = child(list, 'Culture')?.text;
    const value = child(list, 'Text')?.text;
    if (culture && value) out[culture] = value;
  }
  return out;
}
