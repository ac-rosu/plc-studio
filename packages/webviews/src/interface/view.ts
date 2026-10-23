// Block interface editor (spec, "Block interface editor (v1)"): one table per section, like TIA's
// interface editor. Every change is sent to the extension as an edit intent.
import { clear, h } from '../shared/dom.ts';
import {
  button,
  checkCell,
  datalist,
  failsafeBanner,
  problemsCell,
  textCell,
  toolbar,
  type Post,
} from '../tables-common/grid.ts';

export interface Row {
  path: string[];
  level: number;
  name: string;
  type: string;
  value: string;
  defaultValue: string;
  retain: boolean | null;
  accessible: boolean;
  visible: boolean;
  writable: boolean;
  setpoint: boolean;
  comment: string;
  start: number;
  end: number;
  structured: boolean;
  declarationEditable: boolean;
  problems: string[];
}

export interface InterfaceModel {
  view: 'interface';
  blockName: string;
  blockKind: string;
  format: 's7dcl' | 'source';
  failsafe: boolean;
  culture: string;
  sections: { kind: string; label: string; rows: Row[]; canAdd: boolean; returnType?: string }[];
  types: string[];
  error?: string;
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

export function renderInterface(root: HTMLElement, model: InterfaceModel, post: Post): void {
  clear(root);
  if (model.error) {
    root.append(
      toolbar(button('Open text', 'Open the text of this file', () => post({ type: 'openText' }))),
      h('div', { class: 'empty' }, model.error),
    );
    return;
  }
  const edit = (op: string, extra: Record<string, unknown>) => post({ type: 'edit', op, ...extra });
  root.append(
    ...[failsafeBanner(model.failsafe)].filter((x): x is HTMLElement => x !== null),
    toolbar(
      h('strong', {}, `${model.blockKind} ${model.blockName}`),
      h('span', { class: 'muted' }, `comments in ${model.culture}`),
      button('Open text', 'Open the text of this file', () => post({ type: 'openText' })),
    ),
    datalist('types', model.types),
  );
  const table = h('table', { class: 'grid', 'aria-label': `Interface of ${model.blockName}` });
  table.append(h('thead', {}, h('tr', {}, ...HEADERS.map((x) => h('th', { scope: 'col' }, x)))));
  const body = h('tbody', {});
  for (const section of model.sections) {
    body.append(
      h(
        'tr',
        { class: 'section' },
        h(
          'th',
          { colspan: String(HEADERS.length - 1), scope: 'rowgroup' },
          section.label,
          section.returnType !== undefined ? `: ${section.returnType}` : '',
        ),
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
    for (const row of section.rows) body.append(memberRow(row, section.kind, edit, post));
  }
  table.append(body);
  root.append(table);
}

function memberRow(
  row: Row,
  section: string,
  edit: (op: string, extra: Record<string, unknown>) => void,
  post: Post,
): HTMLTableRowElement {
  const label = (what: string) => `${what} of ${row.path.join('.')}`;
  const can = row.declarationEditable;
  const flag = (name: string) =>
    can ? (v: boolean) => edit('flag', { path: row.path, flag: name, value: v }) : undefined;
  const tr = h(
    'tr',
    { class: `level-${Math.min(row.level, 4)} ${row.problems.length ? 'has-problem' : ''}` },
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
    checkCell(row.accessible, label('Accessible from HMI/OPC UA'), flag('accessible')),
    checkCell(row.visible, label('Visible in HMI engineering'), flag('visible')),
    checkCell(row.writable, label('Writable from HMI/OPC UA'), flag('writable')),
    checkCell(row.setpoint, label('Setpoint'), flag('setpoint')),
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
    ),
  );
  return tr;
}

/** A blank row for a new member: committed when it has a name and a type. */
function addRow(
  body: HTMLElement,
  section: string,
  after: Row | undefined,
  edit: (op: string, extra: Record<string, unknown>) => void,
): void {
  let name = '';
  let type = '';
  let comment = '';
  const tryCommit = () => {
    if (name && type)
      edit('add', {
        section,
        name,
        typeText: type,
        comment,
        ...(after && after.level === 0 ? { after: after.path } : {}),
      });
  };
  const tr = h(
    'tr',
    { class: 'new-row' },
    textCell('', `New member name in ${section}`, (v) => ((name = v.trim()), tryCommit()), {
      placeholder: 'Name',
    }),
    textCell('', `New member data type in ${section}`, (v) => ((type = v.trim()), tryCommit()), {
      list: 'types',
      placeholder: 'Data type',
    }),
    h('td', {}),
    h('td', {}),
    h('td', {}),
    h('td', {}),
    h('td', {}),
    h('td', {}),
    textCell('', `New member comment in ${section}`, (v) => (comment = v), {
      placeholder: 'Comment',
    }),
    h('td', {}),
    h('td', {}),
  );
  const rows = [...body.querySelectorAll('tr')];
  const sectionRows = rows.filter((r) => r.classList.contains('section'));
  const header = sectionRows.find((r) => r.textContent?.startsWith(section));
  const nextHeader = header ? sectionRows[sectionRows.indexOf(header) + 1] : undefined;
  if (nextHeader) body.insertBefore(tr, nextHeader);
  else body.append(tr);
  tr.querySelector('input')?.focus();
}
