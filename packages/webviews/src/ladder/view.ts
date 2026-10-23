// The LAD/FBD view: renders the block, keeps the selection, and turns mouse and keyboard input
// into intents for the extension (spec: viewer M8, editor M10).
import type { ElementRef, ElementView, NetworkView } from '@plcstudio/core';
import { clear, h } from '../shared/dom.ts';
import { drawNetwork } from './draw.ts';
import type {
  CompletionEntry,
  EditIntent,
  HostToView,
  LadderModel,
  ViewMessage,
} from './protocol.ts';

type Send = (message: ViewMessage) => void;

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2];

interface Selection {
  network: number;
  element: string | undefined;
}

export class LadderView {
  private readonly root: HTMLElement;
  private readonly send: Send;
  private model: LadderModel | undefined;
  private version = 0;
  private zoom = 1;
  private paletteOpen = false;
  private selection: Selection = { network: 1, element: undefined };
  private requestId = 0;
  private readonly pendingHover = new Map<number, (text: string) => void>();
  private readonly pendingCompletion = new Map<
    number,
    (items: readonly CompletionEntry[]) => void
  >();
  private tooltip: HTMLElement | undefined;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private editor: HTMLElement | undefined;
  private status: HTMLElement | undefined;

  constructor(root: HTMLElement, send: Send) {
    this.root = root;
    this.send = send;
    root.addEventListener('keydown', (e) => this.onKey(e));
  }

  get currentModel(): LadderModel | undefined {
    return this.model;
  }

  get selected(): Selection {
    return this.selection;
  }

  // --- Messages from the extension ------------------------------------------------------------

  receive(message: HostToView): void {
    switch (message.type) {
      case 'update':
        this.model = message.model;
        this.version = message.version;
        this.render();
        break;
      case 'hoverResult':
        this.pendingHover.get(message.id)?.(message.text);
        this.pendingHover.delete(message.id);
        break;
      case 'completionResult':
        this.pendingCompletion.get(message.id)?.(message.items);
        this.pendingCompletion.delete(message.id);
        break;
      case 'select':
        this.selection = {
          network: message.network,
          element:
            message.rung !== undefined && message.item !== undefined
              ? `${message.network}:${message.rung}:${message.item}`
              : undefined,
        };
        this.render();
        this.focusSelection();
        break;
      case 'error':
        this.setStatus(message.message, true);
        break;
    }
  }

  private edit(intent: EditIntent): void {
    this.send({ type: 'edit', version: this.version, intent });
  }

  private setStatus(text: string, error = false): void {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.className = `status${error ? ' diag-error' : ''}`;
  }

  // --- Rendering -----------------------------------------------------------------------------

  render(): void {
    const model = this.model;
    clear(this.root);
    if (!model) return;
    const view = model.view;
    this.status = h('span', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const toolbar = h(
      'div',
      { class: 'toolbar', role: 'toolbar', 'aria-label': 'LAD/FBD view tools' },
      h(
        'button',
        {
          class: 'secondary',
          title: 'Zoom out (Ctrl+-)',
          'aria-label': 'Zoom out',
          onclick: () => this.setZoom(-1),
        },
        '−',
      ),
      h('span', { class: 'muted', 'aria-label': 'Zoom level' }, `${Math.round(this.zoom * 100)}%`),
      h(
        'button',
        {
          class: 'secondary',
          title: 'Zoom in (Ctrl+=)',
          'aria-label': 'Zoom in',
          onclick: () => this.setZoom(1),
        },
        '+',
      ),
      h(
        'button',
        {
          class: 'secondary',
          title: 'Show the text of this block',
          onclick: () => this.send({ type: 'openText' }),
        },
        'Open text',
      ),
      model.editable && view
        ? h(
            'button',
            {
              class: 'secondary',
              'aria-pressed': String(this.paletteOpen),
              title: 'Show or hide the instruction palette',
              onclick: () => this.togglePalette(),
            },
            'Palette',
          )
        : null,
      model.editable && view
        ? h(
            'button',
            {
              class: 'secondary',
              title: 'Add a network after the selected one',
              onclick: () =>
                this.edit({
                  op: 'addNetwork',
                  after: this.selection.network,
                  language: view.language === 'FBD' ? 'FBD' : 'LAD',
                }),
            },
            'Add network',
          )
        : null,
      h(
        'span',
        { class: 'muted' },
        view
          ? `${view.namespace ? view.namespace + '.' : ''}${view.name} · ${view.language}${view.displayLanguage ? ` · ${view.displayLanguage}` : ''}`
          : model.fileName,
      ),
      this.status,
    );
    this.root.append(toolbar);
    if (view?.failsafe) {
      this.root.append(
        h(
          'div',
          { class: 'banner failsafe', role: 'note' },
          'Fail-safe block. After any change, compile the safety program in TIA and have it accepted again by a qualified person; the collective F-signature changes. PLC Studio is not a safety-certified tool.',
        ),
      );
    }
    if (!view) {
      this.root.append(
        h('p', { class: 'muted message' }, model.message ?? 'Nothing to draw in this file.'),
      );
      return;
    }
    const main = h('div', { class: 'networks' });
    for (const n of view.networks) main.append(this.renderNetwork(n));
    const body = h(
      'div',
      { class: 'ladder-body' },
      main,
      this.paletteOpen && model.editable ? this.renderPalette() : null,
    );
    this.root.append(body);
  }

  private elementDiagnostics(n: NetworkView): {
    severity: Map<string, 'error' | 'warning' | 'info'>;
    messages: Map<string, string>;
    rest: LadderModel['diagnostics'];
  } {
    const severity = new Map<string, 'error' | 'warning' | 'info'>();
    const messages = new Map<string, string>();
    const rest: LadderModel['diagnostics'][number][] = [];
    const rank = { error: 3, warning: 2, info: 1 };
    for (const d of this.model?.diagnostics ?? []) {
      if (d.end < n.range.start || d.start > n.range.end) continue;
      const hit = n.layout?.elements.find(
        (e) => d.start >= e.range.start && d.start <= e.range.end,
      );
      if (!hit) {
        rest.push(d);
        continue;
      }
      if ((rank[severity.get(hit.id) ?? 'info'] ?? 0) <= rank[d.severity] || !severity.has(hit.id))
        severity.set(hit.id, d.severity);
      messages.set(hit.id, [messages.get(hit.id), d.message].filter(Boolean).join(' '));
    }
    return { severity, messages, rest };
  }

  private renderNetwork(n: NetworkView): HTMLElement {
    const model = this.model!;
    const selectedNetwork = this.selection.network === n.index;
    const diags = this.elementDiagnostics(n);
    const titleText = n.title ?? '';
    const header = h(
      'div',
      { class: 'network-header' },
      h('span', { class: 'network-number' }, `Network ${n.index}`),
      h(
        'span',
        {
          class: 'network-title',
          title: n.otherTitles.map((t) => `${t.culture}: ${t.text}`).join('\n') || undefined,
        },
        titleText ? `: ${titleText}` : '',
      ),
      model.editable ? this.networkActions(n) : null,
    );
    const section = h(
      'section',
      {
        class: `network${selectedNetwork ? ' selected' : ''}`,
        'data-network': String(n.index),
        tabindex: selectedNetwork && !this.selection.element ? 0 : -1,
        'aria-label': `Network ${n.index}${titleText ? `: ${titleText}` : ''}${n.kind !== 'drawn' ? `, shown as text: ${n.reason ?? ''}` : ''}`,
        onclick: (e: MouseEvent) => {
          if ((e.target as Element).closest('.el, button, input')) return;
          this.selection = { network: n.index, element: undefined };
          this.markSelection();
        },
      },
      header,
    );
    if (n.comment) section.append(h('div', { class: 'network-comment muted' }, n.comment));
    for (const l of n.labels)
      section.append(h('div', { class: 'network-label' }, `Label ${l.name}`));
    if (n.kind === 'drawn' && n.layout) {
      const drawing = drawNetwork(n.layout, {
        scale: this.zoom,
        severity: diags.severity,
        messages: diags.messages,
        selected: this.selection.element,
      });
      drawing.setAttribute('aria-label', `Rungs of network ${n.index}`);
      this.wireDrawing(drawing, n);
      section.append(h('div', { class: 'drawing' }, drawing));
    } else {
      section.append(
        h(
          'div',
          { class: `text-network ${n.kind}` },
          h(
            'div',
            { class: 'muted' },
            n.kind === 'text'
              ? 'SCL network'
              : n.kind === 'empty'
                ? `Empty network: ${n.reason ?? ''}`
                : `Shown as text: ${n.reason ?? ''}`,
          ),
          h('pre', { class: 'code' }, n.text ?? ''),
          h(
            'button',
            {
              class: 'secondary',
              onclick: () =>
                this.send({ type: 'reveal', start: n.keywordRange.start, end: n.keywordRange.end }),
            },
            'Open text',
          ),
        ),
      );
    }
    if (diags.rest.length) {
      section.append(
        h(
          'ul',
          { class: 'network-diagnostics' },
          ...diags.rest.map((d) => h('li', { class: `diag-${d.severity}` }, d.message)),
        ),
      );
    }
    return section;
  }

  private networkActions(n: NetworkView): HTMLElement {
    const act = (label: string, title: string, intent: EditIntent) =>
      h(
        'button',
        {
          class: 'secondary small',
          title,
          'aria-label': `${title} (network ${n.index})`,
          onclick: () => this.edit(intent),
        },
        label,
      );
    return h(
      'span',
      { class: 'network-actions' },
      h(
        'button',
        { class: 'secondary small', title: 'Edit the title', onclick: () => this.editTitle(n) },
        'Title',
      ),
      act('↑', 'Move up', { op: 'moveNetwork', network: n.index, direction: -1 }),
      act('↓', 'Move down', { op: 'moveNetwork', network: n.index, direction: 1 }),
      act('⧉', 'Duplicate', { op: 'duplicateNetwork', network: n.index }),
      act('Copy', 'Copy', { op: 'copyNetwork', network: n.index }),
      act('Paste', 'Paste after this network', { op: 'pasteNetwork', after: n.index }),
      act('✕', 'Delete', { op: 'deleteNetwork', network: n.index }),
    );
  }

  private renderPalette(): HTMLElement {
    const model = this.model!;
    const language = model.view?.language === 'FBD' ? 'FBD' : 'LAD';
    const items = model.palette.filter((p) => p.languages.includes(language));
    return h(
      'aside',
      { class: 'palette', 'aria-label': 'Instruction palette' },
      h(
        'div',
        { class: 'muted' },
        model.view?.failsafe ? 'Fail-safe instructions' : 'Instructions',
      ),
      ...items.map((p) =>
        h(
          'div',
          {
            class: 'palette-item',
            draggable: 'true',
            tabindex: 0,
            role: 'button',
            title: p.description,
            'aria-label': `Insert ${p.name}: ${p.description}`,
            ondragstart: (e: DragEvent) =>
              e.dataTransfer?.setData('application/x-plcstudio-element', p.name),
            onclick: () => this.insertFromPalette(p.name),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.insertFromPalette(p.name);
              }
            },
          },
          h('span', { class: 'palette-symbol' }, p.symbol),
          ' ',
          p.name,
        ),
      ),
    );
  }

  private wireDrawing(drawing: SVGSVGElement, n: NetworkView): void {
    drawing.addEventListener('click', (e) => {
      const target = e.target as Element;
      const el = target.closest('.el');
      if (!el) return;
      const id = el.getAttribute('data-id')!;
      if ((e.ctrlKey || e.metaKey) && target.hasAttribute('data-start')) {
        this.send({ type: 'definition', offset: Number(target.getAttribute('data-start')) });
        return;
      }
      this.selection = { network: n.index, element: id };
      this.markSelection();
    });
    drawing.addEventListener('dblclick', (e) => {
      const target = e.target as Element;
      if (target.hasAttribute('data-start') || target.hasAttribute('data-pin'))
        this.editOperand(target as SVGTextElement, n);
      else {
        const el = n.layout?.elements.find(
          (x) => x.id === target.closest('.el')?.getAttribute('data-id'),
        );
        if (el) this.send({ type: 'reveal', start: el.range.start, end: el.range.end });
      }
    });
    drawing.addEventListener('mouseover', (e) => {
      const target = e.target as Element;
      if (!target.hasAttribute('data-start')) return;
      if (this.hoverTimer) clearTimeout(this.hoverTimer);
      this.hoverTimer = setTimeout(
        () => this.hover(target, Number(target.getAttribute('data-start'))),
        350,
      );
    });
    drawing.addEventListener('mouseout', () => {
      if (this.hoverTimer) clearTimeout(this.hoverTimer);
      this.tooltip?.remove();
      this.tooltip = undefined;
    });
    if (this.model?.editable) {
      drawing.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('application/x-plcstudio-element')) e.preventDefault();
      });
      drawing.addEventListener('drop', (e) => {
        const name = e.dataTransfer?.getData('application/x-plcstudio-element');
        if (!name) return;
        e.preventDefault();
        const el = n.layout?.elements.find(
          (x) => x.id === (e.target as Element).closest('.el')?.getAttribute('data-id'),
        );
        const target = el ?? n.layout?.elements.at(-1);
        if (target) this.insertAt(target, name);
      });
    }
  }

  private markSelection(): void {
    for (const g of this.root.querySelectorAll('.el')) {
      const on = g.getAttribute('data-id') === this.selection.element;
      g.classList.toggle('selected', on);
      g.setAttribute('tabindex', on ? '0' : '-1');
    }
    for (const s of this.root.querySelectorAll('section.network')) {
      const on = Number(s.getAttribute('data-network')) === this.selection.network;
      s.classList.toggle('selected', on);
      s.setAttribute('tabindex', on && !this.selection.element ? '0' : '-1');
    }
  }

  private focusSelection(): void {
    const target = this.selection.element
      ? this.root.querySelector<SVGGElement>(`.el[data-id="${this.selection.element}"]`)
      : this.root.querySelector<HTMLElement>(
          `section.network[data-network="${this.selection.network}"]`,
        );
    target?.focus();
  }

  private setZoom(step: number): void {
    const i = ZOOMS.indexOf(this.zoom);
    this.zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 4 : i) + step))]!;
    this.render();
    this.focusSelection();
  }

  private togglePalette(): void {
    this.paletteOpen = !this.paletteOpen;
    this.render();
  }

  // --- Navigation -----------------------------------------------------------------------------

  private network(index: number): NetworkView | undefined {
    return this.model?.view?.networks.find((n) => n.index === index);
  }

  private selectedElement(): ElementView | undefined {
    const n = this.network(this.selection.network);
    return n?.layout?.elements.find((e) => e.id === this.selection.element);
  }

  private refOf(e: ElementView): ElementRef {
    return { network: this.selection.network, rung: e.rung, item: e.item };
  }

  /** Elements in reading order: by rung line, then left to right. */
  private ordered(n: NetworkView): ElementView[] {
    return [...(n.layout?.elements ?? [])].sort((a, b) => a.lineY - b.lineY || a.x - b.x);
  }

  private moveSelection(dx: number, dy: number): void {
    const n = this.network(this.selection.network);
    if (!n) return;
    const list = this.ordered(n);
    const current = this.selectedElement();
    if (!current) {
      this.selection.element = list[0]?.id;
    } else if (dy === 0) {
      const i = list.indexOf(current);
      this.selection.element = list[Math.max(0, Math.min(list.length - 1, i + dx))]?.id;
    } else {
      const candidates = list.filter((e) =>
        dy > 0 ? e.lineY > current.lineY : e.lineY < current.lineY,
      );
      candidates.sort(
        (a, b) =>
          Math.abs(a.lineY - current.lineY) - Math.abs(b.lineY - current.lineY) ||
          Math.abs(a.x - current.x) - Math.abs(b.x - current.x),
      );
      if (candidates[0]) this.selection.element = candidates[0].id;
    }
    this.markSelection();
    this.focusSelection();
  }

  private moveNetworkSelection(step: number): void {
    const nets = this.model?.view?.networks ?? [];
    const i = nets.findIndex((n) => n.index === this.selection.network);
    const next = nets[Math.max(0, Math.min(nets.length - 1, i + step))];
    if (!next) return;
    this.selection = { network: next.index, element: undefined };
    this.markSelection();
    this.focusSelection();
    this.root
      .querySelector(`section.network[data-network="${next.index}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as Element).closest('input, .operand-editor')) return;
    const editable = this.model?.editable ?? false;
    const element = this.selectedElement();
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+'))
      return void (e.preventDefault(), this.setZoom(1));
    if ((e.ctrlKey || e.metaKey) && e.key === '-')
      return void (e.preventDefault(), this.setZoom(-1));
    if (e.key === 'PageDown' || (e.altKey && e.key === 'ArrowDown' && !element))
      return void (e.preventDefault(), this.moveNetworkSelection(1));
    if (e.key === 'PageUp' || (e.altKey && e.key === 'ArrowUp' && !element))
      return void (e.preventDefault(), this.moveNetworkSelection(-1));
    if (editable && element && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      this.edit({
        op: 'move',
        ref: this.refOf(element),
        direction: e.key === 'ArrowLeft' ? -1 : 1,
      });
      return;
    }
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        this.moveSelection(1, 0);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        this.moveSelection(-1, 0);
        return;
      case 'ArrowDown':
        e.preventDefault();
        this.moveSelection(0, 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        this.moveSelection(0, -1);
        return;
      case 'Escape':
        this.selection.element = undefined;
        this.markSelection();
        this.focusSelection();
        return;
      case 'F12':
        if (element?.operand) {
          e.preventDefault();
          this.send({ type: 'definition', offset: element.operand.start });
        }
        return;
      case 'Enter': {
        if (!element) return;
        e.preventDefault();
        const operand = this.root.querySelector<SVGTextElement>(
          `.el[data-id="${element.id}"] [data-start], .el[data-id="${element.id}"] [data-pin]`,
        );
        const n = this.network(this.selection.network)!;
        if (editable && operand) this.editOperand(operand, n);
        else this.send({ type: 'reveal', start: element.range.start, end: element.range.end });
        return;
      }
      case 'Delete':
        if (!editable) return;
        e.preventDefault();
        if (element) this.edit({ op: 'delete', ref: this.refOf(element) });
        else this.edit({ op: 'deleteNetwork', network: this.selection.network });
        return;
      case 'b':
      case 'B':
        if (editable && element && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          this.edit({ op: 'addBranch', ref: this.refOf(element) });
        }
        return;
      case 'c':
      case 'C':
        if (editable && (e.ctrlKey || e.metaKey) && !element)
          this.edit({ op: 'copyNetwork', network: this.selection.network });
        return;
      case 'v':
      case 'V':
        if (editable && (e.ctrlKey || e.metaKey))
          this.edit({ op: 'pasteNetwork', after: this.selection.network });
        return;
      case 'Insert':
        if (editable) {
          e.preventDefault();
          this.paletteOpen = true;
          this.render();
          this.root.querySelector<HTMLElement>('.palette-item')?.focus();
        }
        return;
    }
  }

  // --- Hover, completion, operand editing -------------------------------------------------------

  private hover(target: Element, offset: number): void {
    const id = ++this.requestId;
    this.pendingHover.set(id, (text) => {
      if (!text) return;
      this.tooltip?.remove();
      const rect = target.getBoundingClientRect();
      this.tooltip = h(
        'div',
        {
          class: 'tooltip',
          role: 'tooltip',
          style: { left: `${rect.left}px`, top: `${rect.bottom + 4}px` },
        },
        text,
      );
      document.body.append(this.tooltip);
    });
    this.send({ type: 'hover', id, offset });
  }

  /** Opens an inline input over an operand (or an unconnected pin) with completion. */
  editOperand(target: SVGTextElement, n: NetworkView): void {
    if (!this.model?.editable) return;
    this.editor?.remove();
    const elementId = target.closest('.el')?.getAttribute('data-id');
    const element = n.layout?.elements.find((e) => e.id === elementId);
    if (!element) return;
    const start = target.hasAttribute('data-start')
      ? Number(target.getAttribute('data-start'))
      : undefined;
    const end = target.hasAttribute('data-end')
      ? Number(target.getAttribute('data-end'))
      : undefined;
    const pin = target.getAttribute('data-pin') ?? undefined;
    const original = start !== undefined ? (target.textContent ?? '') : '';
    const rect = target.getBoundingClientRect();
    const input = h('input', {
      value: original,
      'aria-label': pin ? `Operand for ${pin}` : 'Operand',
      spellcheck: 'false',
    });
    const list = h('ul', { class: 'completions', role: 'listbox' });
    const editor = h(
      'div',
      {
        class: 'operand-editor',
        style: { left: `${Math.max(0, rect.left - 4)}px`, top: `${rect.top - 4}px` },
      },
      input,
      list,
    );
    this.editor = editor;
    document.body.append(editor);
    input.focus();
    input.select();
    let items: readonly CompletionEntry[] = [];
    let active = -1;
    const showItems = () => {
      clear(list);
      items.slice(0, 12).forEach((c, i) =>
        list.append(
          h(
            'li',
            {
              role: 'option',
              class: i === active ? 'active' : '',
              'aria-selected': String(i === active),
              onmousedown: (e: MouseEvent) => {
                e.preventDefault();
                input.value = c.insertText;
                commit();
              },
            },
            c.label,
            c.detail ? h('span', { class: 'muted' }, ` ${c.detail}`) : null,
          ),
        ),
      );
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      const id = ++this.requestId;
      this.pendingCompletion.set(id, (result) => {
        items = result.filter((c) =>
          c.label.toLowerCase().includes(input.value.replace(/^[#"]/, '').toLowerCase()),
        );
        active = items.length ? 0 : -1;
        showItems();
      });
      this.send({
        type: 'complete',
        id,
        offset: start ?? element.range.start,
        prefix: input.value,
      });
    };
    const close = () => {
      editor.remove();
      if (this.editor === editor) this.editor = undefined;
      this.focusSelection();
    };
    const commit = () => {
      const value = input.value.trim();
      close();
      if (!value || value === original) return;
      if (start !== undefined && end !== undefined)
        this.edit({ op: 'setOperand', start, end, expected: original, text: value });
      else if (pin)
        this.edit({
          op: 'connectPin',
          ref: { network: n.index, rung: element.rung, item: element.item },
          pin,
          direction: 'in',
          text: value,
        });
    };
    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(ask, 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (
          active >= 0 &&
          items[active] &&
          input.value !== items[active]!.insertText &&
          list.childElementCount
        )
          input.value = items[active]!.insertText;
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) {
          active =
            (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.min(items.length, 12);
          showItems();
        }
      }
    });
    input.addEventListener('blur', () => setTimeout(() => editor.isConnected && close(), 150));
  }

  private editTitle(n: NetworkView): void {
    const value = window.prompt?.(`Title of network ${n.index}`, n.title ?? '');
    if (value === null || value === undefined) return;
    this.edit({ op: 'setText', network: n.index, role: 'title', text: value });
  }

  // --- Palette ---------------------------------------------------------------------------------

  /** Coils and jumps take the new element in front of them; other elements after them. */
  private insertAt(target: ElementView, name: string): void {
    const before = target.shape === 'coil' || target.shape === 'jump' || target.shape === 'assign';
    const network = Number(target.id.split(':')[0]);
    this.selection = { network, element: target.id };
    this.edit({
      op: 'insert',
      ref: { network, rung: target.rung, item: before ? target.item : target.item + 1 },
      element: name,
    });
  }

  private insertFromPalette(name: string): void {
    const element = this.selectedElement();
    if (element) return this.insertAt(element, name);
    const n = this.network(this.selection.network);
    const last = n?.layout?.elements.at(-1);
    if (last) this.insertAt(last, name);
    else if (n)
      this.edit({ op: 'insert', ref: { network: n.index, rung: 0, item: -1 }, element: name });
  }
}
