// Read-only table models of a SimaticML block or PLC data type (ADR 0014): the same rows the
// interface and data block editors show for the text formats, taken from the XML, which holds
// the interface with start values, every comment language and the members of PLC data types.
// Free of the VS Code API, so the corpus tests can compare them with the text formats.
import { memberInitializer, type SimaticmlBlock, type SimaticmlMember } from '@plcstudio/core';
import type { DataBlockModel, InterfaceModel, Row } from './tables-model.ts';

/** Shown above every view of a SimaticML file. */
export const XML_READ_ONLY_NOTE =
  'SimaticML export, shown read-only and not checked. Change the block in TIA Portal or in its SIMATIC SD or source file.';

const INTERFACE_SECTIONS = ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant'];

/** The kind the views name: FB, FC, OB, DB or UDT. */
export const xmlBlockKind = (block: SimaticmlBlock): string =>
  block.kind === 'GlobalDB' || block.kind === 'InstanceDB' || block.kind === 'ArrayDB'
    ? 'DB'
    : block.kind;

function row(
  m: SimaticmlMember,
  path: string[],
  level: number,
  culture: string,
  value: string,
  structured: boolean,
  retainShown: boolean,
): Row {
  const accessible = m.accessible ?? true;
  return {
    path,
    level,
    name: path[path.length - 1]!,
    type: m.datatype,
    value,
    defaultValue: m.startValue ?? '',
    retain: retainShown ? m.remanence === 'Retain' : null,
    accessible,
    // a flag the XML leaves out follows ExternalAccessible, as in tag tables (C04)
    visible: m.visible ?? accessible,
    writable: m.writable ?? accessible,
    setpoint: m.setpoint ?? false,
    comment: m.comment[culture] ?? '',
    start: 0,
    end: 0,
    structured,
    declarationEditable: false,
    problems: [],
  };
}

/** Interface rows: struct members nested below their parent, as the interface editor shows them. */
function interfaceRows(
  members: readonly SimaticmlMember[],
  prefix: string[],
  level: number,
  culture: string,
  section: string,
  out: Row[],
): void {
  for (const m of members) {
    const path = [...prefix, m.name];
    const struct = m.datatype === 'Struct';
    out.push(
      row(
        m,
        path,
        level,
        culture,
        struct ? '' : (memberInitializer(m) ?? ''),
        struct,
        section === 'Static' && level === 0,
      ),
    );
    if (struct) interfaceRows(m.members, path, level + 1, culture, section, out);
  }
}

export function xmlInterfaceModel(
  block: SimaticmlBlock,
  culture: string,
): InterfaceModel & { readonly readOnly: true } {
  const kind = xmlBlockKind(block);
  const sections: InterfaceModel['sections'] = [];
  if (block.kind === 'UDT') {
    const rows: Row[] = [];
    for (const s of block.sections) interfaceRows(s.members, [], 0, culture, 'None', rows);
    sections.push({ kind: 'Struct', label: 'Members', rows, canAdd: false });
  } else {
    const names = kind === 'DB' ? ['Input', 'Output', 'InOut', 'Static'] : INTERFACE_SECTIONS;
    for (const name of names) {
      const section = block.sections.find((s) => s.name === name);
      if (!section && kind === 'DB') continue;
      const rows: Row[] = [];
      interfaceRows(section?.members ?? [], [], 0, culture, name, rows);
      sections.push({
        kind: name as InterfaceModel['sections'][number]['kind'],
        label: name,
        rows,
        canAdd: false,
      });
    }
    if (block.kind === 'FC') {
      const ret = block.sections.find((s) => s.name === 'Return')?.members[0];
      sections.push({
        kind: 'Return',
        label: 'Return',
        rows: [],
        canAdd: false,
        returnType: ret?.datatype ?? 'Void',
      });
    }
  }
  return {
    view: 'interface',
    blockIndex: 0,
    blockName: block.name,
    blockKind: kind,
    format: 'simaticml',
    failsafe: block.failsafe,
    culture,
    sections,
    types: [],
    readOnly: true,
  };
}

/** Indexes of every element of `Array[a..b, c..d] of T`, in TIA's order (last index fastest). */
function arrayIndexes(datatype: string, max: number): string[] | undefined {
  const m = /^Array\s*\[([^\]]+)\]\s+of\s+/i.exec(datatype);
  if (!m) return undefined;
  const dims = m[1]!.split(',').map((d) => {
    const r = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(d);
    return r ? ([Number(r[1]), Number(r[2])] as const) : undefined;
  });
  if (dims.some((d) => !d)) return undefined;
  let out: string[] = [''];
  for (const [lo, hi] of dims as (readonly [number, number])[]) {
    const next: string[] = [];
    for (const prefix of out)
      for (let i = lo; i <= hi && next.length < max; i++)
        next.push(prefix ? `${prefix},${i}` : String(i));
    out = next;
  }
  return out;
}

const MAX_ELEMENTS = 100;

/**
 * Data block rows: members, the members of their PLC data types and structs, and array elements
 * with their start values (`<Subelement Path="1">`), as the data block editor shows them.
 */
function dataBlockRows(
  members: readonly SimaticmlMember[],
  prefix: string[],
  level: number,
  culture: string,
  out: Row[],
  note: { text?: string },
  elementValues?: ReadonlyMap<string, string>,
): void {
  for (const m of members) {
    const path = [...prefix, m.name];
    const own = elementValues?.get(m.name);
    const indexes = arrayIndexes(m.datatype, MAX_ELEMENTS);
    if (indexes) {
      out.push(row(m, path, level, culture, '', true, level === 0));
      if (/\.\.\s*(\d+)/.test(m.datatype) && indexes.length >= MAX_ELEMENTS)
        note.text = `Arrays show their first ${MAX_ELEMENTS} elements.`;
      const elementType = m.datatype.replace(/^Array\s*\[[^\]]+\]\s+of\s+/i, '');
      for (const index of indexes) {
        const elementPath = [...prefix, `${m.name}[${index}]`];
        if (m.members.length === 0) {
          const value = m.elements.find((e) => e.path === index)?.value ?? '';
          out.push({
            ...row(m, elementPath, level + 1, culture, value, false, false),
            type: elementType,
            comment: '',
          });
          continue;
        }
        out.push({
          ...row(m, elementPath, level + 1, culture, '', true, false),
          type: elementType,
          comment: '',
        });
        // start values of the element's members sit on those members, by element path
        const values = new Map<string, string>();
        for (const sub of m.members)
          for (const e of sub.elements) if (e.path === index) values.set(sub.name, e.value);
        dataBlockRows(m.members, elementPath, level + 2, culture, out, note, values);
      }
      continue;
    }
    if (m.members.length > 0) {
      out.push(row(m, path, level, culture, '', true, level === 0));
      dataBlockRows(m.members, path, level + 1, culture, out, note);
      continue;
    }
    out.push(row(m, path, level, culture, own ?? m.startValue ?? '', false, level === 0));
  }
}

export function xmlDataBlockModel(
  block: SimaticmlBlock,
  culture: string,
): DataBlockModel & { readonly readOnly: true } {
  const rows: Row[] = [];
  const note: { text?: string } = {};
  const members = block.sections.flatMap((s) => s.members);
  const array = block.kind === 'ArrayDB' ? members[0] : undefined;
  if (array) {
    // an array DB is one array: its elements are THIS[0], THIS[1] … as in the text formats
    dataBlockRows([{ ...array, name: 'THIS' }], [], -1, culture, rows, note);
    rows.shift();
  } else {
    dataBlockRows(members, [], 0, culture, rows, note);
  }
  return {
    view: 'datablock',
    blockIndex: 0,
    blockName: block.name,
    dbKind:
      block.kind === 'InstanceDB' ? 'instance' : block.kind === 'ArrayDB' ? 'array' : 'global',
    instanceOf: block.instanceOf ?? '',
    format: 'simaticml',
    failsafe: block.failsafe,
    culture,
    rows,
    types: [],
    readOnly: true,
    ...(note.text ? { note: note.text } : {}),
  };
}
