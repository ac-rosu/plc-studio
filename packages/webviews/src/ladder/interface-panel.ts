// The block interface above the networks, as in TIA's block editor (owner, 2026-10-24): a
// collapsible panel holding the block interface editor's table. Closed unless the setting opens
// it; the extension sends the interface only while the panel is open.
import { h } from '../shared/dom.ts';
import { preserveFocus } from '../tables-common/grid.ts';
import type { InterfaceModel } from '../interface/model.ts';
import { renderInterface } from '../interface/view.ts';
import type { ViewMessage } from './protocol.ts';

export class InterfacePanel {
  readonly element: HTMLDetailsElement;
  private readonly content: HTMLElement;
  private readonly send: (message: ViewMessage) => void;

  constructor(send: (message: ViewMessage) => void, open: boolean) {
    this.send = send;
    this.content = h('div', { class: 'interface-content' }, h('p', { class: 'muted' }, 'Loading…'));
    this.element = h(
      'details',
      { class: 'interface-panel' },
      h('summary', {}, 'Block interface'),
      this.content,
    );
    // also fires for the initial open below, once the panel is in the page
    this.element.addEventListener('toggle', () => {
      if (this.element.open) this.request();
    });
    this.element.open = open;
  }

  /** The block text changed: while open, ask for the interface again. */
  refresh(): void {
    if (this.element.open) this.request();
  }

  show(model: InterfaceModel): void {
    preserveFocus(this.content, () =>
      renderInterface(this.content, model, (m) => this.forward(m), { embedded: true }),
    );
  }

  private request(): void {
    this.send({ type: 'interfaceRequest' });
  }

  /** Edits go to the interface editor's handler; reveal and open text work as in the drawing. */
  private forward(message: { type: string; [key: string]: unknown }): void {
    if (message.type === 'edit') this.send({ ...message, type: 'interfaceEdit' });
    else if (message.type === 'reveal' || message.type === 'openText')
      this.send(message as ViewMessage);
  }
}
