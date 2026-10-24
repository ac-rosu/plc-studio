// A file can hold several blocks (external sources, C42): the table views show each one in its own
// collapsible section, in file order, and every edit names its block. A file with one block looks
// exactly as before.
import { clear, h } from '../shared/dom.ts';
import { preserveFocus, type Post } from './grid.ts';

export interface FileModel<M> {
  readonly blocks: readonly M[];
}

export function renderBlocks<M extends { readonly blockIndex?: number }>(
  root: HTMLElement,
  file: FileModel<M>,
  render: (root: HTMLElement, model: M, post: Post) => void,
  post: Post,
  title: (model: M) => string,
): void {
  const only = file.blocks.length === 1 ? file.blocks[0] : undefined;
  if (only !== undefined || file.blocks.length === 0) {
    preserveFocus(root, () => (only !== undefined ? render(root, only, post) : clear(root)));
    return;
  }
  // member names repeat across blocks, so focus is kept within the same block
  const active = document.activeElement as HTMLInputElement | null;
  const focused = active && root.contains(active) ? active : null;
  const focusBlock = focused?.closest<HTMLElement>('[data-block]')?.dataset['block'];
  const label = focused?.getAttribute('aria-label');
  const selection = focused?.selectionStart ?? null;
  const open = new Map(
    [...root.querySelectorAll<HTMLDetailsElement>('details[data-block]')].map((d) => [
      d.dataset['block'],
      d.open,
    ]),
  );
  clear(root);
  for (const model of file.blocks) {
    const index = model.blockIndex ?? 0;
    const body = h('div', { class: 'block-body' });
    const section = h(
      'details',
      { class: 'block-section', 'data-block': String(index) },
      h('summary', {}, title(model)),
      body,
    );
    section.open = open.get(String(index)) ?? true;
    root.append(section);
    render(body, model, (m) => post(m.type === 'edit' ? { ...m, block: index } : m));
  }
  // one list of data types is enough: the inputs refer to it by id
  const seen = new Set<string>();
  for (const list of root.querySelectorAll('datalist')) {
    if (seen.has(list.id)) list.remove();
    else seen.add(list.id);
  }
  if (focusBlock !== undefined && label) {
    const target = root.querySelector<HTMLInputElement>(
      `[data-block="${focusBlock}"] [aria-label="${CSS.escape(label)}"]`,
    );
    if (target) {
      target.focus();
      if (selection !== null && target.type === 'text')
        target.setSelectionRange(selection, selection);
    }
  }
}
