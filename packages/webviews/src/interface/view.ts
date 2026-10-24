// Block interface editor (spec, "Block interface editor (v1)"): one table per section, like TIA's
// interface editor. Every change is sent to the extension as an edit intent.
import { clear, h } from '../shared/dom.ts';
import {
  afterDescendants,
  button,
  checkCell,
  datalist,
  failsafeBanner,
  newMemberRow,
  problemsCell,
  textCell,
  toolbar,
  type Post,
} from '../tables-common/grid.ts';
import type { InterfaceModel, Row } from './model.ts';

export type { InterfaceModel, Row } from './model.ts';

export interface InterfaceOptions {
  /** Inside the LAD/FBD view: no fail-safe banner and no toolbar, that view shows its own. */
  readonly embedded?: boolean;
}

const HEADERS = [
  'Name',
  'Data type',
  'Default value',
  'Retain',
  'Accessible',
  'Visible',
  'Writable',
  'Setpoint',
  'Comment',
  'Problems',
  '',
];

/**
 * HMI/OPC UA flags exist only where a member lives in a DB: FB parameters and statics (instance
 * DB), UDT members and DB members. FC and OB parameters, Temp and Constant have none in TIA.
 */
function hmiFlagsApply(blockKind: string, section: string): boolean {
  if (blockKind === 'UDT' || blockKind === 'DB') return true;
  return blockKind === 'FB' && ['Input', 'Output', 'InOut', 'Static'].includes(section);
}

export function renderInterface(
  root: HTMLElement,
  model: InterfaceModel,
  post: Post,
  options: InterfaceOptions = {},
): void {
  clear(root);
  if (model.error) {
    if (!options.embedded)
      root.append(
        toolbar(
          button('Open text', 'Open the text of this file', () => post({ type: 'openText' })),
        ),
      );
    root.append(h('div', { class: 'view-message' }, model.error));
    return;
  }
  const edit = (op: string, extra: Record<string, unknown>) => post({ type: 'edit', op, ...extra });
  if (!options.embedded)
    root.append(
      ...[failsafeBanner(model.failsafe)].filter((x): x is HTMLElement => x !== null),
      toolbar(
        h('strong', {}, `${model.blockKind} ${model.blockName}`),
        h('span', { class: 'muted' }, `comments in ${model.culture}`),
        button('Open text', 'Open the text of this file', () => post({ type: 'openText' })),
      ),
    );
  root.append(datalist('types', model.types));
  const table = h('table', { class: 'grid', 'aria-label': `Interface of ${model.blockName}` });
  table.append(h('thead', {}, h('tr', {}, ...HEADERS.map((x) => h('th', { scope: 'col' }, x)))));
  const body = h('tbody', {});
  for (const section of model.sections) {
    body.append(
      h(
        'tr',
        { class: 'section' },
        h('th', { colspan: String(HEADERS.length - 1), scope: 'rowgroup' }, section.label),
        h(
          'th',
          {},
          section.canAdd
            ? button(
                '+',
                `Add a member to ${section.label}`,
                () => addRow(body, section.kind, section.rows.at(-1), edit),
                'secondary',
              )
            : '',
        ),
      ),
    );
    if (section.kind === 'Return' && section.returnType !== undefined)
      body.append(returnTypeRow(section.returnType, edit));
    const flags = hmiFlagsApply(model.blockKind, section.kind);
    for (const row of section.rows) body.append(memberRow(row, section.kind, flags, edit, post));
  }
  table.append(body);
  root.append(table);
}

function memberRow(
  row: Row,
  section: string,
  hmiFlags: boolean,
  edit: (op: string, extra: Record<string, unknown>) => void,
  post: Post,
): HTMLTableRowElement {
  const label = (what: string) => `${what} of ${row.path.join('.')}`;
  const can = row.declarationEditable;
  const flag = (name: string) =>
    can ? (v: boolean) => edit('flag', { path: row.path, flag: name, value: v }) : undefined;
  // a Struct member gets a + that adds a member inside it
  const addInside =
    can && row.structured && /^struct$/i.test(row.type)
      ? button('+', `Add a member to ${row.path.join('.')}`, () => {
          const child = newMemberRow(row.path.join('.'), row.level + 1, 6, (name, type, comment) =>
            edit('add', { section, name, typeText: type, comment, parent: row.path }),
          );
          tr.parentElement?.insertBefore(child, afterDescendants(tr));
          child.querySelector('input')?.focus();
        })
      : null;
  const tr: HTMLTableRowElement = h(
    'tr',
    {
      class: `level-${Math.min(row.level, 4)} ${row.problems.length ? 'has-problem' : ''}`,
      'data-level': String(row.level),
    },
    textCell(
      row.name,
      label('Name'),
      can ? (v) => edit('rename', { path: row.path, value: v }) : undefined,
    ),
    row.structured
      ? h('td', { class: 'muted' }, row.type)
      : textCell(
          row.type,
          label('Data type'),
          can ? (v) => edit('type', { path: row.path, value: v }) : undefined,
          { list: 'types' },
        ),
    row.structured
      ? h('td', {})
      : textCell(
          row.value,
          label('Default value'),
          can ? (v) => edit('value', { path: row.path, value: v }) : undefined,
        ),
    section === 'Static' && row.level === 0 && row.retain !== null
      ? checkCell(row.retain, label('Retain'), flag('retain'))
      : h('td', {}),
    ...(hmiFlags
      ? [
          checkCell(row.accessible, label('Accessible from HMI/OPC UA'), flag('accessible')),
          checkCell(row.visible, label('Visible in HMI engineering'), flag('visible')),
          checkCell(row.writable, label('Writable from HMI/OPC UA'), flag('writable')),
          checkCell(row.setpoint, label('Setpoint'), flag('setpoint')),
        ]
      : [h('td', {}), h('td', {}), h('td', {}), h('td', {})]),
    textCell(row.comment, label('Comment'), (v) => edit('comment', { path: row.path, value: v })),
    problemsCell(row.problems),
    h(
      'td',
      { class: 'actions' },
      button('↑', label('Move up'), () => edit('move', { path: row.path, direction: -1 })),
      button('↓', label('Move down'), () => edit('move', { path: row.path, direction: 1 })),
      button('✕', label('Delete'), () => edit('delete', { path: row.path })),
      button('⤴', label('Show in text'), () =>
        post({ type: 'reveal', start: row.start, end: row.end }),
      ),
      addInside,
    ),
  );
  return tr;
}

/** The return type of a function, editable like a data type. */
function returnTypeRow(
  returnType: string,
  edit: (op: string, extra: Record<string, unknown>) => void,
): HTMLTableRowElement {
  return h(
    'tr',
    { 'data-level': '0' },
    h('td', { class: 'muted' }, 'Return value'),
    textCell(returnType, 'Return type of the function', (v) => edit('returnType', { value: v }), {
      list: 'types',
    }),
    ...Array.from({ length: HEADERS.length - 2 }, () => h('td', {})),
  );
}

/** A blank row at the end of a section: committed when it has a name and a type. */
function addRow(
  body: HTMLElement,
  section: string,
  after: Row | undefined,
  edit: (op: string, extra: Record<string, unknown>) => void,
): void {
  // after the last top-level member; a nested last row means the end of the section
  const last = after?.level === 0 ? after : undefined;
  const tr = newMemberRow(section, 0, 6, (name, type, comment) =>
    edit('add', {
      section,
      name,
      typeText: type,
      comment,
      ...(last ? { after: last.path } : {}),
    }),
  );
  const rows = [...body.querySelectorAll('tr')];
  const sectionRows = rows.filter((r) => r.classList.contains('section'));
  const header = sectionRows.find((r) => r.textContent?.startsWith(section));
  const nextHeader = header ? sectionRows[sectionRows.indexOf(header) + 1] : undefined;
  if (nextHeader) body.insertBefore(tr, nextHeader);
  else body.append(tr);
  tr.querySelector('input')?.focus();
}
