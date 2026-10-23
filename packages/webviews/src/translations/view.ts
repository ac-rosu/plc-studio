// Translation table (spec, "Translation table (v1)"): every comment and title of a block, one row
// per text and one column per language; missing translations are highlighted.
import { clear, h } from '../shared/dom.ts';
import { button, failsafeBanner, textCell, toolbar, type Post } from '../tables-common/grid.ts';

export interface TranslationModel {
  view: 'translations';
  blockName: string;
  failsafe: boolean;
  cultures: string[];
  culture: string;
  rows: {
    id: string;
    context: string;
    texts: Record<string, string>;
    missing: string[];
    start: number;
    end: number;
  }[];
  error?: string;
}

interface State {
  onlyMissing: boolean;
  extraCultures: string[];
}

const state: State = { onlyMissing: false, extraCultures: [] };

export function renderTranslations(root: HTMLElement, model: TranslationModel, post: Post): void {
  clear(root);
  if (model.error) {
    root.append(
      toolbar(button('Open text', 'Open the text of this file', () => post({ type: 'openText' }))),
      h('div', { class: 'empty' }, model.error),
    );
    return;
  }
  const cultures = [...new Set([...model.cultures, ...state.extraCultures])].sort();
  const missingCount = model.rows.filter((r) => r.missing.length > 0).length;
  const filter = h('input', {
    type: 'checkbox',
    'aria-label': 'Show only texts with missing translations',
  });
  filter.checked = state.onlyMissing;
  filter.addEventListener('change', () => {
    state.onlyMissing = filter.checked;
    renderTranslations(root, model, post);
  });
  const newCulture = h('input', {
    type: 'text',
    placeholder: 'xx-XX',
    size: '6',
    'aria-label': 'Language to add, for example fr-FR',
  });
  const addCulture = () => {
    const c = newCulture.value.trim();
    if (/^[a-z]{2,3}-[A-Z]{2,4}$/.test(c) && !cultures.includes(c)) {
      state.extraCultures.push(c);
      renderTranslations(root, model, post);
    }
  };
  root.append(
    ...[failsafeBanner(model.failsafe)].filter((x): x is HTMLElement => x !== null),
    toolbar(
      h('strong', {}, `Texts of ${model.blockName}`),
      h(
        'span',
        { class: missingCount ? 'diag-warning' : 'muted' },
        `${model.rows.length} texts, ${missingCount} with missing translations`,
      ),
      h('label', {}, filter, ' only missing'),
      newCulture,
      button('+ Language', 'Add a language column', addCulture),
      button('Open text', 'Open the text of this file', () => post({ type: 'openText' })),
    ),
  );
  if (model.rows.length === 0) {
    root.append(h('div', { class: 'empty' }, 'This block has no comments or titles yet.'));
    return;
  }
  const table = h('table', { class: 'grid', 'aria-label': `Translations of ${model.blockName}` });
  table.append(
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col' }, 'Text id'),
        h('th', { scope: 'col' }, 'Used by'),
        ...cultures.map((c) => h('th', { scope: 'col' }, c)),
      ),
    ),
  );
  const body = h('tbody', {});
  for (const row of model.rows) {
    if (state.onlyMissing && row.missing.length === 0) continue;
    body.append(
      h(
        'tr',
        {},
        h('td', { class: 'muted' }, row.id),
        h(
          'td',
          {},
          h(
            'a',
            {
              href: '#',
              onClick: (e: Event) => (
                e.preventDefault(),
                post({ type: 'reveal', start: row.start, end: row.end })
              ),
            },
            row.context,
          ),
        ),
        ...cultures.map((c) => {
          const cell = textCell(row.texts[c] ?? '', `${c} text of ${row.context}`, (v) =>
            post({ type: 'edit', op: 'text', id: row.id, culture: c, value: v }),
          );
          if (row.missing.includes(c) || (state.extraCultures.includes(c) && !row.texts[c]))
            cell.classList.add('missing');
          return cell;
        }),
      ),
    );
  }
  table.append(body);
  root.append(table);
}
