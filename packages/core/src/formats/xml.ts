// A small XML reader that keeps exact offsets, for SimaticML tag tables and OB attributes.
// It never rewrites a file: edits are made on the recorded ranges.
import type { Range } from '../text/source-text.ts';

export interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, { value: string; range: Range }>;
  readonly children: XmlElement[];
  /** From '<' of the start tag to '>' of the end tag. */
  readonly range: Range;
  /** Text content between the tags (only for elements without child elements). */
  readonly text: string;
  /** Range of the text content (empty range right after the start tag when there is none). */
  readonly textRange: Range;
  readonly parent: XmlElement | undefined;
}

interface MutableElement {
  name: string;
  attributes: Map<string, { value: string; range: Range }>;
  children: MutableElement[];
  range: { start: number; end: number };
  text: string;
  textRange: { start: number; end: number };
  parent: MutableElement | undefined;
}

export function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    switch (e) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(
          e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
        );
    }
  });
}

export function encodeEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Parses well-formed XML; returns the root element, or undefined if there is none. */
export function parseXml(text: string): XmlElement | undefined {
  const root: MutableElement = {
    name: '#document',
    attributes: new Map(),
    children: [],
    range: { start: 0, end: text.length },
    text: '',
    textRange: { start: 0, end: 0 },
    parent: undefined,
  };
  let current = root;
  const tag =
    /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(text))) {
    if (!m[2]) continue; // declaration, comment, CDATA
    const [whole, closing, name, attrText, selfClosing] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    const start = m.index;
    const end = start + whole.length;
    if (closing) {
      if (current.name === name) {
        current.range.end = end;
        if (current.children.length === 0) {
          current.textRange.end = start;
          current.text = decodeEntities(text.slice(current.textRange.start, start));
        }
        current = current.parent ?? root;
      }
      continue;
    }
    const attributes = new Map<string, { value: string; range: Range }>();
    const attr = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    const attrBase = start + 1 + name.length;
    while ((a = attr.exec(attrText))) {
      const valueStart = attrBase + a.index + a[0].indexOf('"') + 1;
      attributes.set(a[1]!, {
        value: decodeEntities(a[2]!),
        range: { start: valueStart, end: valueStart + a[2]!.length },
      });
    }
    const element: MutableElement = {
      name,
      attributes,
      children: [],
      range: { start, end },
      text: '',
      textRange: { start: end, end },
      parent: current,
    };
    current.children.push(element);
    if (!selfClosing) current = element;
  }
  return root.children[0] as XmlElement | undefined;
}

export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((c) => c.name === name);
}

export function children(element: XmlElement | undefined, name: string): XmlElement[] {
  return element?.children.filter((c) => c.name === name) ?? [];
}

export function descendants(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(element);
  return out;
}

/** Text of <AttributeList><name>…</name></AttributeList>. */
export function attributeText(element: XmlElement, name: string): XmlElement | undefined {
  return child(child(element, 'AttributeList'), name);
}

/** MultilingualText items under an element: culture → text. */
export function multilingual(
  element: XmlElement,
  composition: string,
): Map<string, { text: string; range: Range }> {
  const out = new Map<string, { text: string; range: Range }>();
  const text = children(child(element, 'ObjectList'), 'MultilingualText').find(
    (t) => t.attributes.get('CompositionName')?.value === composition,
  );
  for (const item of children(child(text, 'ObjectList'), 'MultilingualTextItem')) {
    const culture = attributeText(item, 'Culture')?.text;
    const value = attributeText(item, 'Text');
    if (culture && value) out.set(culture, { text: value.text, range: value.textRange });
  }
  return out;
}
