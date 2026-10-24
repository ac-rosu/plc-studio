// Tag table editor (spec, "Tag table editor"): tags and user constants with all attributes,
// comments per language, address checks, CSV import/export. System constants are read-only.
import { clear, h } from '../shared/dom.ts';
import {
  button,
  checkCell,
  failsafeBanner,
  textCell,
  toolbar,
  type Post,
} from '../tables-common/grid.ts';

export interface TagRow {
  kind: 'tag' | 'constant' | 'systemConstant';
  name: string;
  dataType: string;
  address: string;
  value: string;
  accessible: boolean;
  visible: boolean;
  writable: boolean;
  comments: Record<string, string>;
  problems: { severity: string; message: string }[];
  start: number;
  end: number;
}

export interface TagTableModel {
  view: 'tagtable';
  name: string;
  family: string;
  cultures: string[];
  culture: string;
  rows: TagRow[];
  error?: string;
}

const state = { culture: '', filter: '' };

const HEADERS = [
  'Kind',
  'Name',
  'Data type',
  'Address / value',
  'Accessible',
  'Visible',
  'Writable',
  'Comment',
  'Problems',
  '',
];

export function renderTagTable(root: HTMLElement, model: TagTableModel, post: Post): void {
  clear(root);
  if (model.error) {
    root.append(
      toolbar(button('Open text', 'Open the text of this file', () => post({ type: 'openText' }))),
      h('div', { class: 'view-message' }, model.error),
    );
    return;
  }
  const culture = model.cultures.includes(state.culture) ? state.culture : model.culture;
  const edit = (op: string, extra: Record<string, unknown>) => post({ type: 'edit', op, ...extra });
  const cultureSelect = h(
    'select',
    { 'aria-label': 'Language of the comment column' },
    ...model.cultures.map((c) =>
      h('option', { value: c, selected: c === culture ? 'selected' : undefined }, c),
    ),
  );
  cultureSelect.value = culture;
  cultureSelect.addEventListener('change', () => {
    state.culture = cultureSelect.value;
    renderTagTable(root, model, post);
  });
  const filter = h('input', {
    type: 'search',
    value: state.filter,
    placeholder: 'Filter',
    'aria-label': 'Filter tags by name, type or address',
  });
  filter.addEventListener('input', () => {
    state.filter = filter.value;
    renderTagTable(root, model, post);
    (root.querySelector('input[type=search]') as HTMLInputElement | null)?.focus();
  });
  root.append(
    ...[failsafeBanner(false)].filter((x): x is HTMLElement => x !== null),
    toolbar(
      h('strong', {}, model.name),
      h(
        'span',
        { class: 'muted' },
        model.family ? `addresses checked for ${model.family}` : 'no CPU family in plc.json',
      ),
      newEntryForm(edit),
      filter,
      cultureSelect,
      button('Import CSV', 'Import tags from a CSV file', () => edit('importCsv', {})),
      button('Export CSV', 'Export the tags to a CSV file', () => edit('exportCsv', {})),
      button('Open text', 'Open the text of this file', () => post({ type: 'openText' })),
    ),
  );
  const table = h('table', { class: 'grid', 'aria-label': `Tag table ${model.name}` });
  table.append(h('thead', {}, h('tr', {}, ...HEADERS.map((x) => h('th', { scope: 'col' }, x)))));
  const body = h('tbody', {});
  const f = state.filter.toLowerCase();
  for (const row of model.rows) {
    if (
      f &&
      ![row.name, row.dataType, row.address, row.value].some((x) => x.toLowerCase().includes(f))
    )
      continue;
    const readOnly = row.kind === 'systemConstant';
    const label = (what: string) => `${what} of ${row.name}`;
    const flag = (name: string) =>
      readOnly ? undefined : (v: boolean) => edit('flag', { name: row.name, flag: name, value: v });
    const worst = row.problems.find((p) => p.severity !== 'info') ?? row.problems[0];
    body.append(
      h(
        'tr',
        { class: row.problems.some((p) => p.severity !== 'info') ? 'has-problem' : '' },
        h(
          'td',
          { class: 'muted' },
          row.kind === 'tag' ? 'Tag' : row.kind === 'constant' ? 'Constant' : 'System constant',
        ),
        textCell(
          row.name,
          label('Name'),
          readOnly ? undefined : (v) => edit('rename', { name: row.name, value: v }),
        ),
        textCell(
          row.dataType,
          label('Data type'),
          readOnly ? undefined : (v) => edit('type', { name: row.name, value: v }),
        ),
        row.kind === 'tag'
          ? textCell(row.address, label('Address'), (v) =>
              edit('address', { name: row.name, value: v }),
            )
          : textCell(
              row.value,
              label('Value'),
              readOnly ? undefined : (v) => edit('value', { name: row.name, value: v }),
            ),
        checkCell(row.accessible, label('Accessible from HMI/OPC UA'), flag('ExternalAccessible')),
        checkCell(row.visible, label('Visible in HMI engineering'), flag('ExternalVisible')),
        checkCell(row.writable, label('Writable from HMI/OPC UA'), flag('ExternalWritable')),
        textCell(
          row.comments[culture] ?? '',
          `${culture} ${label('Comment')}`,
          readOnly ? undefined : (v) => edit('comment', { name: row.name, culture, value: v }),
        ),
        h(
          'td',
          {
            class: worst && worst.severity !== 'info' ? 'diag-warning' : 'muted',
            title: row.problems.map((p) => p.message).join('\n'),
          },
          worst ? worst.message : '',
        ),
        h(
          'td',
          { class: 'actions' },
          readOnly ? null : button('✕', label('Delete'), () => edit('delete', { name: row.name })),
          button('⤴', label('Show in text'), () =>
            post({ type: 'reveal', start: row.start, end: row.end }),
          ),
        ),
      ),
    );
  }
  table.append(body);
  root.append(table);
}

function newEntryForm(edit: (op: string, extra: Record<string, unknown>) => void): HTMLElement {
  const kind = h(
    'select',
    { 'aria-label': 'Kind of the new entry' },
    h('option', { value: 'tag' }, 'Tag'),
    h('option', { value: 'constant' }, 'Constant'),
  );
  const name = h('input', {
    type: 'text',
    placeholder: 'Name',
    size: '12',
    'aria-label': 'Name of the new tag or constant',
  });
  const type = h('input', {
    type: 'text',
    placeholder: 'Data type',
    size: '8',
    'aria-label': 'Data type of the new tag or constant',
  });
  const where = h('input', {
    type: 'text',
    placeholder: 'Address / value',
    size: '10',
    'aria-label': 'Address of the new tag or value of the new constant',
  });
  const add = () => {
    if (!name.value.trim()) return;
    edit('add', {
      kind: kind.value,
      newName: name.value.trim(),
      dataType: type.value.trim() || 'Bool',
      addressOrValue: where.value.trim(),
    });
    name.value = '';
    where.value = '';
  };
  where.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  return h(
    'span',
    {},
    kind,
    name,
    type,
    where,
    button('+ Add', 'Add the new tag or constant', add),
  );
}
