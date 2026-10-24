// Data block editor (spec, "Data block editor (v1)"): global, array and instance DBs in one table
// with start values. Instance DBs show the FB interface read-only; start values stay editable.
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
import type { Row } from '../interface/view.ts';

export interface DataBlockModel {
  view: 'datablock';
  blockName: string;
  dbKind: 'global' | 'instance' | 'array' | '';
  instanceOf: string;
  format: 's7dcl' | 'source';
  failsafe: boolean;
  culture: string;
  rows: Row[];
  types: string[];
  note?: string;
  error?: string;
}

const HEADERS = [
  'Name',
  'Data type',
  'Start value',
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

export function renderDataBlock(root: HTMLElement, model: DataBlockModel, post: Post): void {
  clear(root);
  if (model.error) {
    root.append(
      toolbar(button('Open text', 'Open the text of this file', () => post({ type: 'openText' }))),
      h('div', { class: 'view-message' }, model.error),
    );
    return;
  }
  const edit = (op: string, extra: Record<string, unknown>) => post({ type: 'edit', op, ...extra });
  const kindText =
    model.dbKind === 'instance'
      ? `instance DB of ${model.instanceOf}`
      : model.dbKind === 'array'
        ? 'array DB'
        : 'global DB';
  root.append(
    ...[failsafeBanner(model.failsafe)].filter((x): x is HTMLElement => x !== null),
    toolbar(
      h('strong', {}, model.blockName),
      h('span', { class: 'muted' }, kindText),
      model.dbKind === 'global' ? newMemberForm(edit) : null,
      button('Open text', 'Open the text of this file', () => post({ type: 'openText' })),
    ),
    datalist('types', model.types),
  );
  if (model.note) root.append(h('div', { class: 'note' }, model.note));
  const table = h('table', { class: 'grid', 'aria-label': `Data block ${model.blockName}` });
  table.append(h('thead', {}, h('tr', {}, ...HEADERS.map((x) => h('th', { scope: 'col' }, x)))));
  const body = h('tbody', {});
  for (const row of model.rows) {
    const label = (what: string) => `${what} of ${row.path.join('.')}`;
    const can = row.declarationEditable;
    const flag = (name: string) =>
      can ? (v: boolean) => edit('flag', { path: row.path, flag: name, value: v }) : undefined;
    const addInside =
      can && row.structured && /^struct$/i.test(row.type)
        ? button('+', `Add a member to ${row.path.join('.')}`, () => {
            const child = newMemberRow(
              row.path.join('.'),
              row.level + 1,
              7,
              (name, type, comment) =>
                edit('add', { section: 'Static', name, typeText: type, comment, parent: row.path }),
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
      row.structured || !can
        ? h('td', { class: 'muted' }, row.type)
        : textCell(
            row.type,
            label('Data type'),
            (v) => edit('type', { path: row.path, value: v }),
            { list: 'types' },
          ),
      row.structured
        ? h('td', {})
        : textCell(row.value, label('Start value'), (v) =>
            edit('start', { path: row.path, value: v }),
          ),
      h('td', { class: 'muted' }, row.defaultValue),
      row.level === 0 && row.retain !== null
        ? checkCell(row.retain, label('Retain'), flag('retain'))
        : h('td', {}),
      checkCell(row.accessible, label('Accessible from HMI/OPC UA'), flag('accessible')),
      checkCell(row.visible, label('Visible in HMI engineering'), flag('visible')),
      checkCell(row.writable, label('Writable from HMI/OPC UA'), flag('writable')),
      checkCell(row.setpoint, label('Setpoint'), flag('setpoint')),
      textCell(
        row.comment,
        label('Comment'),
        can ? (v) => edit('comment', { path: row.path, value: v }) : undefined,
      ),
      problemsCell(row.problems),
      h(
        'td',
        { class: 'actions' },
        can && row.level === 0
          ? button('↑', label('Move up'), () => edit('move', { path: row.path, direction: -1 }))
          : null,
        can && row.level === 0
          ? button('↓', label('Move down'), () => edit('move', { path: row.path, direction: 1 }))
          : null,
        can ? button('✕', label('Delete'), () => edit('delete', { path: row.path })) : null,
        button('⤴', label('Show in text'), () =>
          post({ type: 'reveal', start: row.start, end: row.end }),
        ),
        addInside,
      ),
    );
    body.append(tr);
  }
  table.append(body);
  root.append(table);
}

/** Name and type inputs plus an Add button (webviews have no prompt dialogs). */
function newMemberForm(edit: (op: string, extra: Record<string, unknown>) => void): HTMLElement {
  const name = h('input', {
    type: 'text',
    placeholder: 'New member',
    'aria-label': 'Name of the new member',
  });
  const type = h('input', {
    type: 'text',
    placeholder: 'Data type',
    list: 'types',
    'aria-label': 'Data type of the new member',
  });
  const add = () => {
    if (!name.value.trim() || !type.value.trim()) return;
    edit('add', { section: 'Static', name: name.value.trim(), typeText: type.value.trim() });
    name.value = '';
    type.value = '';
  };
  type.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  return h('span', {}, name, type, button('+ Add', 'Add the new member', add));
}
