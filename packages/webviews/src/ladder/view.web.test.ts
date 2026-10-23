// The LAD/FBD view in a real browser: rendering, fallback, diagnostics, keyboard and palette.
import { ladderBlockView, parseBlockText } from '@plcstudio/core';
import { profileIndex } from '@plcstudio/profiles';
import { afterEach, describe, expect, it } from 'vitest';
import type { LadderModel, ViewMessage } from './protocol.ts';
import { LadderView } from './view.ts';

const profile = profileIndex('V21')!;
const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

function text(safety = false, networks?: string[][]): string {
  const nets = networks ?? [
    [
      'RUNG wire#powerrail',
      '    Contact( #Start )',
      '    wire#w1',
      '    I_Contact( #Stop )',
      '    Coil( #Motor )',
      'END_RUNG',
      'RUNG wire#powerrail',
      '    Contact( #Motor )',
      'END_RUNG wire#w1',
    ],
    [
      'RUNG wire#powerrail',
      '    { S7_Templates := "time_type := Time" }',
      '    #Delay.TON(',
      '        pt := T#2s,',
      '        et => #Elapsed',
      '    )',
      '    Coil( #Done )',
      'END_RUNG',
    ],
    ['RUNG wire#powerrail', '    Contact( #Start', 'END_RUNG'],
  ];
  return crlf(
    '{',
    `    S7_PreferredLanguage := "LAD"${safety ? ';' : ''}`,
    ...(safety ? ['    S7_Safety := "TRUE"'] : []),
    '}',
    'FUNCTION_BLOCK "FB_V"',
    ...nets.flatMap((body) => [
      '    { S7_Language := "LAD" }',
      '    NETWORK',
      ...body.map((l) => '        ' + l),
      '    END_NETWORK',
    ]),
    'END_FUNCTION_BLOCK',
  );
}

function model(source: string, diagnostics: LadderModel['diagnostics'] = []): LadderModel {
  return {
    fileName: 'FB_V.s7dcl',
    view: ladderBlockView(parseBlockText(source, 's7dcl'), { profile }),
    diagnostics,
    palette: profile.profile.ladderElements.map((e) => ({
      name: e.name,
      shape: e.shape,
      symbol: e.symbol ?? e.name,
      description: e.description ?? '',
      languages: e.languages,
    })),
    editable: true,
    message: undefined,
  };
}

let root: HTMLElement | undefined;
afterEach(() => root?.remove());

function mount(m: LadderModel): { view: LadderView; sent: ViewMessage[]; root: HTMLElement } {
  root = document.createElement('div');
  root.tabIndex = 0;
  document.body.append(root);
  const sent: ViewMessage[] = [];
  const view = new LadderView(root, (msg) => sent.push(msg));
  view.receive({ type: 'update', model: m, version: 7 });
  return { view, sent, root };
}

const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));

describe('LAD/FBD view', () => {
  it('draws networks as SVG and keeps a broken one as text', () => {
    const { root } = mount(model(text()));
    const sections = root.querySelectorAll('section.network');
    expect(sections).toHaveLength(3);
    expect(sections[0]!.querySelector('svg')).not.toBeNull();
    expect(sections[0]!.querySelectorAll('.el')).toHaveLength(4);
    expect(sections[2]!.querySelector('pre')?.textContent).toContain('Contact( #Start');
    expect(sections[2]!.getAttribute('aria-label')).toMatch(/shown as text/);
  });

  it('labels every element for screen readers', () => {
    const { root } = mount(model(text()));
    const labels = [...root.querySelectorAll('.el')].map((e) => e.getAttribute('aria-label'));
    expect(labels).toContain('Normally open contact #Start');
    expect(labels).toContain('Normally closed contact #Stop');
    expect(
      labels.some((l) =>
        l?.startsWith('Box TON Time with instance #Delay; inputs PT T#2s; outputs ET to #Elapsed'),
      ),
    ).toBe(true);
  });

  it('shows diagnostics on the element they belong to', () => {
    const source = text();
    const start = source.indexOf('#Stop');
    const { root } = mount(
      model(source, [
        { start, end: start + 5, severity: 'error', message: '#Stop is not declared.' },
      ]),
    );
    const el = root.querySelector('.el.diag-error');
    expect(el?.getAttribute('aria-label')).toContain('#Stop is not declared.');
  });

  it('shows the fail-safe banner for F-blocks', () => {
    const { root } = mount(model(text(true)));
    expect(root.querySelector('.banner.failsafe')?.textContent).toMatch(
      /not a safety-certified tool/,
    );
  });

  it('moves through elements with the arrow keys and sends edit intents', () => {
    const { view, sent, root } = mount(model(text()));
    key(root, 'ArrowRight');
    expect(view.selected.element).toBe('1:0:0');
    key(root, 'ArrowRight');
    key(root, 'ArrowDown');
    expect(view.selected.element).toBe('1:1:0');
    key(root, 'Delete');
    expect(sent.at(-1)).toEqual({
      type: 'edit',
      version: 7,
      intent: { op: 'delete', ref: { network: 1, rung: 1, item: 0 } },
    });
    key(root, 'ArrowUp');
    key(root, 'ArrowRight', { altKey: true });
    expect(sent.at(-1)).toMatchObject({ intent: { op: 'move', direction: 1 } });
    key(root, 'PageDown');
    expect(view.selected).toEqual({ network: 2, element: undefined });
  });

  it('inserts palette elements in front of a coil', () => {
    const { view, sent, root } = mount(model(text()));
    root.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click();
    expect(root.querySelectorAll('.palette-item').length).toBeGreaterThan(10);
    view.receive({ type: 'select', network: 1, rung: 0, item: 3 });
    root.querySelector<HTMLElement>('.palette-item[aria-label^="Insert Contact:"]')!.click();
    expect(sent.at(-1)).toMatchObject({
      intent: { op: 'insert', element: 'Contact', ref: { network: 1, rung: 0, item: 3 } },
    });
  });

  it('draws a 100-network block in under one second', () => {
    const networks = Array.from({ length: 100 }, (_, i) => [
      'RUNG wire#powerrail',
      `    Contact( #a${i} )`,
      '    wire#w1',
      `    I_Contact( #b${i} )`,
      `    Coil( #c${i} )`,
      'END_RUNG',
      'RUNG wire#powerrail',
      `    Contact( #d${i} )`,
      'END_RUNG wire#w1',
    ]);
    const t0 = performance.now();
    const { root } = mount(model(text(false, networks)));
    const ms = performance.now() - t0;
    expect(root.querySelectorAll('section.network svg')).toHaveLength(100);
    expect(ms).toBeLessThan(1000);
  });
});
