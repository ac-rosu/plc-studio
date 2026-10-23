// Building blocks shared by the table views: editable cells that commit on Enter or blur and
// revert on Escape, checkboxes with accessible names, arrow-key movement between rows, the
// fail-safe banner and a problem bar.
import { h } from '../shared/dom.ts';
import { injectStyles } from './styles.ts';

injectStyles();

export type Post = (message: { type: string; [key: string]: unknown }) => void;

export const FAILSAFE_TEXT =
  'Fail-safe block: after changes, compile the safety program in TIA Portal and have the change accepted by a qualified person (the collective F-signature changes). PLC Studio is not a safety-certified tool.';

export function failsafeBanner(failsafe: boolean): HTMLElement | null {
  return failsafe ? h('div', { class: 'banner failsafe', role: 'alert' }, FAILSAFE_TEXT) : null;
}

/** A single-line text cell; `onCommit` runs only when the value really changed. */
export function textCell(
  value: string,
  label: string,
  onCommit: ((value: string) => void) | undefined,
  options: { list?: string; placeholder?: string; className?: string } = {},
): HTMLTableCellElement {
  if (!onCommit) return h('td', { class: options.className ?? '', title: value }, value);
  const input = h('input', {
    type: 'text',
    value,
    'aria-label': label,
    spellcheck: 'false',
    ...(options.list ? { list: options.list } : {}),
    ...(options.placeholder ? { placeholder: options.placeholder } : {}),
  });
  let committed = value;
  const commit = () => {
    if (input.value !== committed) {
      committed = input.value;
      onCommit(input.value);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      input.value = committed;
      input.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      moveVertically(input, e.key === 'ArrowDown' ? 1 : -1);
      e.preventDefault();
    }
  });
  input.addEventListener('blur', commit);
  return h('td', { class: options.className ?? '' }, input);
}

export function checkCell(
  value: boolean,
  label: string,
  onChange: ((value: boolean) => void) | undefined,
): HTMLTableCellElement {
  const box = h('input', {
    type: 'checkbox',
    'aria-label': label,
    disabled: onChange ? undefined : 'disabled',
  });
  box.checked = value;
  if (onChange) box.addEventListener('change', () => onChange(box.checked));
  return h('td', { class: 'center' }, box);
}

/** Moves focus to the input in the same column of the next or previous row. */
function moveVertically(input: HTMLElement, step: 1 | -1): void {
  const cell = input.closest('td');
  const row = cell?.parentElement as HTMLTableRowElement | null;
  if (!cell || !row) return;
  const column = Array.prototype.indexOf.call(row.children, cell);
  let next = (
    step === 1 ? row.nextElementSibling : row.previousElementSibling
  ) as HTMLTableRowElement | null;
  while (next) {
    const target = next.children[column]?.querySelector('input');
    if (target) {
      (target as HTMLInputElement).focus();
      return;
    }
    next = (
      step === 1 ? next.nextElementSibling : next.previousElementSibling
    ) as HTMLTableRowElement | null;
  }
}

export function button(
  text: string,
  label: string,
  onClick: () => void,
  className = 'secondary',
): HTMLButtonElement {
  // A button with a word on it is named by that word (WCAG 2.5.3, label in name), so voice control
  // finds it; the longer label becomes its tooltip and description. Symbol buttons (+, ×, ↑) get
  // the label as their name.
  const named = /\p{L}/u.test(text);
  return h(
    'button',
    named
      ? { class: className, title: label, onClick }
      : { class: className, 'aria-label': label, title: label, onClick },
    text,
  );
}

export function toolbar(...children: (Node | string | null)[]): HTMLElement {
  return h('div', { class: 'toolbar', role: 'toolbar' }, ...children);
}

export function problemBar(): { element: HTMLElement; show: (message: string) => void } {
  const element = h('div', { class: 'problem-bar', role: 'status', 'aria-live': 'polite' });
  element.hidden = true;
  return {
    element,
    show(message: string) {
      element.textContent = message;
      element.hidden = false;
      setTimeout(() => (element.hidden = true), 6000);
    },
  };
}

export function datalist(id: string, options: readonly string[]): HTMLDataListElement {
  return h('datalist', { id }, ...options.map((o) => h('option', { value: o })));
}

export function problemsCell(problems: readonly string[]): HTMLTableCellElement {
  if (problems.length === 0) return h('td', {});
  return h(
    'td',
    { class: 'diag-warning', title: problems.join('\n') },
    h('span', { 'aria-label': `Problems: ${problems.join(' ')}` }, '⚠ ' + problems[0]),
  );
}

/** Keeps focus on the same input (by its label) after a re-render. */
export function preserveFocus(root: HTMLElement, render: () => void): void {
  const active = document.activeElement as HTMLInputElement | null;
  const label = active && root.contains(active) ? active.getAttribute('aria-label') : null;
  const selection = active?.selectionStart ?? null;
  render();
  if (label) {
    const target = root.querySelector<HTMLInputElement>(`[aria-label="${CSS.escape(label)}"]`);
    if (target) {
      target.focus();
      if (selection !== null && target.type === 'text')
        target.setSelectionRange(selection, selection);
    }
  }
}
