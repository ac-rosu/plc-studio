// The LAD/FBD view in a real browser: rendering, fallback, diagnostics, keyboard, palette and the
// block interface panel.
import { instructionNames, ladderBlockView, parseBlockText } from '@plcstudio/core';
import { profileIndex } from '@plcstudio/profiles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InterfaceModel, Row } from '../interface/model.ts';
import type { LadderModel, ViewMessage } from './protocol.ts';
import { accessibilityViolations } from '../shared/a11y.ts';
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
    instructions: instructionNames(profile.profile),
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

// Diagram elements show pin names (IN, PT, Q) as SVG text; their name starts with the element kind
// and lists every operand, which the label-in-name heuristic cannot match word for word.
const LADDER_A11Y = { allow: ['label-content-name-mismatch'] } as const;

const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));

describe('LAD/FBD view', () => {
  it('draws networks as SVG and keeps a broken one as text', async () => {
    const { root } = mount(model(text()));
    expect(await accessibilityViolations(root, LADDER_A11Y)).toEqual([]);
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

  it('shows the fail-safe banner for F-blocks', async () => {
    const { root } = mount(model(text(true)));
    expect(await accessibilityViolations(root, LADDER_A11Y)).toEqual([]);
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

const member = (name: string, type: string): Row => ({
  path: [name],
  level: 0,
  name,
  type,
  value: '',
  defaultValue: '',
  retain: null,
  accessible: true,
  visible: true,
  writable: true,
  setpoint: false,
  comment: '',
  start: 0,
  end: 0,
  structured: false,
  declarationEditable: true,
  problems: [],
});

const iface: InterfaceModel = {
  view: 'interface',
  blockName: 'FB_V',
  blockKind: 'FB',
  format: 's7dcl',
  failsafe: false,
  culture: 'en-US',
  sections: [
    {
      kind: 'Input',
      label: 'Input',
      rows: [member('Start', 'Bool'), member('Stop', 'Bool')],
      canAdd: true,
    },
    { kind: 'Output', label: 'Output', rows: [member('Motor', 'Bool')], canAdd: true },
    { kind: 'Static', label: 'Static', rows: [member('Delay', 'TON_TIME')], canAdd: true },
  ],
  types: ['Bool', 'Int', 'TON_TIME'],
};

const panelOf = (root: HTMLElement) =>
  root.querySelector<HTMLDetailsElement>('details.interface-panel')!;
const requests = (sent: ViewMessage[]) => sent.filter((m) => m.type === 'interfaceRequest').length;

describe('LAD/FBD view: block interface panel', () => {
  it('sits closed between the toolbar and the networks and asks for nothing', () => {
    const { root, sent } = mount(model(text()));
    const panel = panelOf(root);
    expect(panel.open).toBe(false);
    const children = [...root.children];
    expect(children.indexOf(panel)).toBe(children.indexOf(root.querySelector('.toolbar')!) + 1);
    expect(children.indexOf(panel)).toBeLessThan(
      children.indexOf(root.querySelector('.ladder-body')!),
    );
    expect(requests(sent)).toBe(0);
  });

  it('asks for the interface when opened and sends table edits as interface edits', async () => {
    const { view, root, sent } = mount(model(text()));
    const panel = panelOf(root);
    panel.open = true;
    await vi.waitFor(() => expect(requests(sent)).toBe(1));
    view.receive({ type: 'interfaceUpdate', model: iface });
    expect(panel.querySelector('table[aria-label="Interface of FB_V"]')).not.toBeNull();
    // the view has its own toolbar and fail-safe banner
    expect(panel.querySelector('.toolbar, .banner')).toBeNull();
    expect(await accessibilityViolations(root, LADDER_A11Y)).toEqual([]);
    const name = panel.querySelector<HTMLInputElement>('input[aria-label="Name of Stop"]')!;
    name.value = 'StopButton';
    key(name, 'Enter');
    expect(sent.at(-1)).toEqual({
      type: 'interfaceEdit',
      op: 'rename',
      path: ['Stop'],
      value: 'StopButton',
    });
  });

  it('stays open and keeps focus across updates, and asks again after each', async () => {
    const { view, root, sent } = mount(model(text()));
    const panel = panelOf(root);
    panel.open = true;
    await vi.waitFor(() => expect(requests(sent)).toBe(1));
    view.receive({ type: 'interfaceUpdate', model: iface });
    const input = panel.querySelector<HTMLInputElement>('input[aria-label="Comment of Start"]')!;
    input.focus();
    view.receive({ type: 'update', model: model(text()), version: 8 });
    expect(panelOf(root)).toBe(panel);
    expect(panel.open).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(requests(sent)).toBe(2);
  });

  it('leaves keys pressed in the panel to the panel', () => {
    const { view, root, sent } = mount(model(text()));
    const summary = panelOf(root).querySelector('summary')!;
    key(summary, 'ArrowRight');
    key(summary, 'Delete');
    expect(view.selected.element).toBeUndefined();
    expect(sent.some((m) => m.type === 'edit')).toBe(false);
  });

  it('opens by itself when the setting asks for it, with one request', async () => {
    const { root, sent } = mount({ ...model(text()), interfaceOpen: true });
    expect(panelOf(root).open).toBe(true);
    await vi.waitFor(() => expect(requests(sent)).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(requests(sent)).toBe(1);
  });

  it('shows a refused interface edit in the status line', () => {
    const { view, root } = mount(model(text()));
    view.receive({ type: 'problem', message: 'A member named Start exists already.' });
    expect(root.querySelector('.status')?.textContent).toBe('A member named Start exists already.');
  });

  it('has no panel when there is nothing to draw', () => {
    const { root } = mount({ ...model(text()), view: undefined, message: 'Nothing to draw.' });
    expect(root.querySelector('details.interface-panel')).toBeNull();
  });
});

// A LAD block with an SCL network (as C21): the drawing shows a short colored preview, and the SCL
// editor opens at the network.
function mixed(statements: string[]): string {
  return crlf(
    '{',
    '    S7_PreferredLanguage := "LAD"',
    '}',
    'FUNCTION_BLOCK "FB_V"',
    '    { S7_Language := "LAD" }',
    '    NETWORK',
    '        RUNG wire#powerrail',
    '            Contact( #Start )',
    '            Coil( #Motor )',
    '        END_RUNG',
    '    END_NETWORK',
    '    { S7_Language := "SCL" }',
    '    NETWORK',
    '        ',
    ...statements.map((l) => '            ' + l),
    '        ',
    '    END_NETWORK',
    'END_FUNCTION_BLOCK',
  );
}

describe('LAD/FBD view: SCL networks', () => {
  const statements = [
    'IF #Start THEN // count the starts',
    '    #Count := #Count + 1;',
    'END_IF;',
    '"DB_Log".Text := \'started\';',
    '#Ready := TRUE AND NOT #Stop;',
  ];

  it('shows a colored preview and opens the SCL editor at the network', async () => {
    const source = mixed(statements);
    const { root, sent } = mount(model(source));
    const net = root.querySelector('section.network[data-network="2"]')!;
    const tokens = (kind: string) =>
      [...net.querySelectorAll(`pre.scl .tok-${kind}`)].map((e) => e.textContent);
    // the roles of the editor's grammar
    expect(tokens('keyword')).toEqual(['IF', 'THEN', 'END_IF', 'TRUE', 'AND', 'NOT']);
    expect(tokens('comment')).toEqual(['// count the starts']);
    expect(tokens('literal')).toEqual(['1', "'started'"]);
    expect(tokens('tag').join('')).toBe('#Start#Count#Count"DB_Log"Text#Ready#Stop');
    expect(tokens('operator')).toEqual([':=', '+', ':=', ':=']);
    expect(net.querySelector('pre.scl')?.textContent).toBe(statements.join('\n'));
    // the editor's colors, light or dark as the theme is
    const firstKeyword = net.querySelector('pre.scl .tok-keyword')!;
    document.body.dataset.vscodeThemeId = 'Light Modern';
    expect(getComputedStyle(firstKeyword).color).toBe('rgb(0, 0, 255)');
    document.body.dataset.vscodeThemeId = 'Monokai Pro';
    expect(getComputedStyle(firstKeyword).color).toBe('rgb(86, 156, 214)');
    delete document.body.dataset.vscodeThemeId;
    expect(await accessibilityViolations(root, LADDER_A11Y)).toEqual([]);
    const button = [...net.querySelectorAll('button')].find(
      (b) => b.textContent === 'Edit in SCL editor',
    )!;
    button.click();
    const keyword = source.indexOf('NETWORK', source.indexOf('"SCL"'));
    expect(sent.at(-1)).toEqual({
      type: 'reveal',
      start: keyword,
      end: keyword + 'NETWORK'.length,
    });
  });

  it('colors a REGION line, instructions and block calls as the editor does', () => {
    const { root } = mount(
      model(
        mixed([
          'REGION Operation : validate (arm 1)',
          '    #Count := DINT_TO_INT(#Total) + ABS(#Delta);',
          '    OP_Validate(Mode := 2, Target := _.Unit.Position);',
          '    "FC_Area"(Tool := #Tool);',
          '    _.Library.FC_Grip(Tool := 1);',
          'END_REGION',
        ]),
      ),
    );
    const net = root.querySelector('section.network[data-network="2"]')!;
    const tokens = (kind: string) =>
      [...net.querySelectorAll(`pre.scl .tok-${kind}`)].map((e) => e.textContent);
    expect(tokens('region').join(' ')).toBe('REGION Operation : validate ( arm 1 ) END_REGION');
    expect(tokens('instruction')).toEqual(['DINT_TO_INT', 'ABS']);
    expect(tokens('parameter')).toEqual(['Mode', 'Target', 'Tool', 'Tool']);
    // block calls stay plain text; a global name outside the unit is a tag
    const plain = [...net.querySelectorAll('pre.scl')].map((p) => p.textContent).join('');
    for (const call of ['OP_Validate', '"FC_Area"', 'FC_Grip'])
      expect(tokens('tag').concat(tokens('instruction'))).not.toContain(call);
    expect(plain).toContain('_.Library.FC_Grip(');
    expect(tokens('tag')).toEqual(expect.arrayContaining(['_', 'Unit', 'Position']));
  });

  it('shows at most twelve lines and says how many are left', () => {
    const long = Array.from({ length: 15 }, (_, i) => `#Count := ${i};`);
    const { root } = mount(model(mixed(long)));
    const net = root.querySelector('section.network[data-network="2"]')!;
    expect(net.querySelector('pre.scl')?.textContent?.split('\n')).toHaveLength(12);
    expect(net.textContent).toContain('3 more lines in the SCL editor');
  });
});
