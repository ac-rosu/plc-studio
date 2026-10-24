// Rendering of the table views and the program graph in a real browser, with the messages they send.
import { describe, expect, it } from 'vitest';
import { renderDataBlock, type DataBlockModel } from './datablock/view.ts';
import { filterGraph, layoutGraph, syntheticGraph } from './graph/layout.ts';
import { createGraphView } from './graph/view.ts';
import { accessibilityViolations } from './shared/a11y.ts';
import { renderInterface, type InterfaceModel, type Row } from './interface/view.ts';
import { renderTagTable, type TagTableModel } from './tagtable/view.ts';
import { renderTranslations, type TranslationModel } from './translations/view.ts';
import { renderBlocks } from './tables-common/blocks.ts';

type Message = { type: string; [key: string]: unknown };

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const sent: Message[] = [];
  return { root, sent, post: (m: Message) => sent.push(m) };
}

function commit(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
}

const row = (name: string, extra: Partial<Row> = {}): Row => ({
  path: [name],
  level: 0,
  name,
  type: 'Int',
  value: '',
  defaultValue: '',
  retain: false,
  accessible: true,
  visible: true,
  writable: true,
  setpoint: false,
  comment: '',
  start: 0,
  end: 1,
  structured: false,
  declarationEditable: true,
  problems: [],
  ...extra,
});

const iface: InterfaceModel = {
  view: 'interface',
  blockName: 'FB_X',
  blockKind: 'FB',
  format: 's7dcl',
  failsafe: true,
  culture: 'en-US',
  sections: [
    {
      kind: 'Input',
      label: 'Input',
      rows: [row('Enable', { type: 'Bool', comment: 'Enable it', retain: null })],
      canAdd: true,
    },
    {
      kind: 'Static',
      label: 'Static',
      rows: [
        row('State'),
        row('Limits', { type: 'Struct', structured: true }),
        row('Min', { path: ['Limits', 'Min'], level: 1, type: 'Real' }),
      ],
      canAdd: true,
    },
  ],
  types: ['Bool', 'Int', 'Real'],
};

describe('interface editor', () => {
  it('embedded in the LAD/FBD view: the table without banner and toolbar', async () => {
    const { root, post } = setup();
    renderInterface(root, iface, post, { embedded: true });
    expect(await accessibilityViolations(root)).toEqual([]);
    expect(root.querySelector('.banner, .toolbar')).toBeNull();
    expect(root.querySelector('table[aria-label="Interface of FB_X"]')).not.toBeNull();
    renderInterface(root, { ...iface, error: 'Not a block.' }, post, { embedded: true });
    expect(root.textContent).toBe('Not a block.');
  });

  it('renders sections, nested members, accessible names and the fail-safe banner', async () => {
    const { root, post } = setup();
    renderInterface(root, iface, post);
    expect(await accessibilityViolations(root)).toEqual([]);
    expect(root.querySelector('.banner.failsafe')?.textContent).toMatch(
      /not a safety-certified tool/,
    );
    expect(
      [...root.querySelectorAll('tr.section')].map((r) => r.textContent?.replace('+', '')),
    ).toEqual(['Input', 'Static']);
    expect(root.querySelector('[aria-label="Name of Limits.Min"]')).not.toBeNull();
    expect(root.querySelector('tr.level-1')).not.toBeNull();
    expect(root.querySelector('[aria-label="Retain of State"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Retain of Enable"]')).toBeNull();
    expect(root.querySelector('[aria-label="Setpoint of Enable"]')).not.toBeNull();
  });

  it('shows HMI flags only where TIA has them: not on Temp, Constant, or FC parameters', () => {
    const { root, post } = setup();
    const sections = [
      { kind: 'Input', label: 'Input', rows: [row('In')], canAdd: true },
      { kind: 'Temp', label: 'Temp', rows: [row('Scratch')], canAdd: true },
      { kind: 'Constant', label: 'Constant', rows: [row('LIMIT')], canAdd: true },
    ];
    renderInterface(root, { ...iface, failsafe: false, sections }, post);
    expect(root.querySelector('[aria-label="Accessible from HMI/OPC UA of In"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Accessible from HMI/OPC UA of Scratch"]')).toBeNull();
    expect(root.querySelector('[aria-label="Setpoint of LIMIT"]')).toBeNull();
    renderInterface(root, { ...iface, blockKind: 'FC', failsafe: false, sections }, post);
    expect(root.querySelector('[aria-label="Accessible from HMI/OPC UA of In"]')).toBeNull();
  });

  it('sends rename, type, comment, flag, move and delete intents', () => {
    const { root, sent, post } = setup();
    renderInterface(root, iface, post);
    commit(root.querySelector<HTMLInputElement>('[aria-label="Name of State"]')!, 'Status');
    commit(root.querySelector<HTMLInputElement>('[aria-label="Data type of State"]')!, 'DInt');
    commit(root.querySelector<HTMLInputElement>('[aria-label="Comment of Enable"]')!, 'Start');
    root.querySelector<HTMLInputElement>('[aria-label="Setpoint of State"]')!.click();
    root.querySelector<HTMLButtonElement>('[aria-label="Move down of State"]')!.click();
    root.querySelector<HTMLButtonElement>('[aria-label="Delete of State"]')!.click();
    expect(sent.map((m) => [m['op'], m['value'] ?? m['direction'] ?? null])).toEqual([
      ['rename', 'Status'],
      ['type', 'DInt'],
      ['comment', 'Start'],
      ['flag', true],
      ['move', 1],
      ['delete', null],
    ]);
  });

  it('does not send an edit when the value did not change, and reverts on Escape', () => {
    const { root, sent, post } = setup();
    renderInterface(root, iface, post);
    const input = root.querySelector<HTMLInputElement>('[aria-label="Name of State"]')!;
    commit(input, 'State');
    input.value = 'Oops';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(input.value).toBe('State');
    expect(sent).toEqual([]);
  });

  it('adds a member inside a struct, below its last nested row', () => {
    const { root, sent, post } = setup();
    renderInterface(root, iface, post);
    expect(root.querySelector('[aria-label="Add a member to State"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[aria-label="Add a member to Limits"]')!.click();
    const name = root.querySelector<HTMLInputElement>('[aria-label="New member name in Limits"]')!;
    // the new row comes right after Limits.Min, one level deeper than Limits
    const tr = name.closest('tr')!;
    expect(
      tr.previousElementSibling?.querySelector('[aria-label="Name of Limits.Min"]'),
    ).not.toBeNull();
    expect(tr.dataset['level']).toBe('1');
    commit(name, 'Max');
    commit(
      root.querySelector<HTMLInputElement>('[aria-label="New member data type in Limits"]')!,
      'Real',
    );
    expect(sent).toEqual([
      {
        type: 'edit',
        op: 'add',
        section: 'Static',
        name: 'Max',
        typeText: 'Real',
        comment: '',
        parent: ['Limits'],
      },
    ]);
  });

  it('edits the return type of a function', () => {
    const { root, sent, post } = setup();
    renderInterface(
      root,
      {
        ...iface,
        blockKind: 'FC',
        failsafe: false,
        sections: [
          { kind: 'Return', label: 'Return', rows: [], canAdd: false, returnType: 'Void' },
        ],
      },
      post,
    );
    const input = root.querySelector<HTMLInputElement>(
      '[aria-label="Return type of the function"]',
    )!;
    expect(input.value).toBe('Void');
    commit(input, 'Int');
    expect(sent).toEqual([{ type: 'edit', op: 'returnType', value: 'Int' }]);
  });

  it('adds a member through the new row', () => {
    const { root, sent, post } = setup();
    renderInterface(root, iface, post);
    root.querySelector<HTMLButtonElement>('[aria-label="Add a member to Static"]')!.click();
    commit(
      root.querySelector<HTMLInputElement>('[aria-label="New member name in Static"]')!,
      'Count',
    );
    commit(
      root.querySelector<HTMLInputElement>('[aria-label="New member data type in Static"]')!,
      'DInt',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'edit',
      op: 'add',
      section: 'Static',
      name: 'Count',
      typeText: 'DInt',
    });
  });
});

// Files with several blocks (external sources, C42): one collapsible section per block.
describe('several blocks in one file', () => {
  const first: InterfaceModel = {
    ...iface,
    blockIndex: 0,
    blockName: 'UDT_A',
    blockKind: 'UDT',
    failsafe: false,
    sections: [{ kind: 'Struct', label: 'Members', rows: [row('Count')], canAdd: true }],
  };
  const second: InterfaceModel = {
    ...first,
    blockIndex: 1,
    blockName: 'FB_B',
    blockKind: 'FB',
    sections: [{ kind: 'Static', label: 'Static', rows: [row('Count')], canAdd: true }],
  };
  const title = (m: InterfaceModel) => `${m.blockKind} ${m.blockName}`;

  it('shows each block in its own open section; edits name their block', async () => {
    const { root, sent, post } = setup();
    renderBlocks(root, { blocks: [first, second] }, renderInterface, post, title);
    const sections = [...root.querySelectorAll<HTMLDetailsElement>('details.block-section')];
    expect(sections.map((d) => [d.querySelector('summary')!.textContent, d.open])).toEqual([
      ['UDT UDT_A', true],
      ['FB FB_B', true],
    ]);
    expect(root.querySelectorAll('datalist')).toHaveLength(1);
    expect(await accessibilityViolations(root)).toEqual([]);
    commit(
      sections[1]!.querySelector<HTMLInputElement>('input[aria-label="Name of Count"]')!,
      'Calls',
    );
    expect(sent.at(-1)).toEqual({
      type: 'edit',
      op: 'rename',
      path: ['Count'],
      value: 'Calls',
      block: 1,
    });
    root.remove();
  });

  it('keeps open state and focus in the same block when it renders again', () => {
    const { root, post } = setup();
    renderBlocks(root, { blocks: [first, second] }, renderInterface, post, title);
    root.querySelector<HTMLDetailsElement>('details[data-block="0"]')!.open = false;
    const input = root.querySelector<HTMLInputElement>(
      'details[data-block="1"] input[aria-label="Comment of Count"]',
    )!;
    input.focus();
    renderBlocks(root, { blocks: [first, second] }, renderInterface, post, title);
    expect(root.querySelector<HTMLDetailsElement>('details[data-block="0"]')!.open).toBe(false);
    expect(document.activeElement?.closest('[data-block]')?.getAttribute('data-block')).toBe('1');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Comment of Count');
    root.remove();
  });

  it('shows a file with one block as before, without a section', () => {
    const { root, sent, post } = setup();
    renderBlocks(root, { blocks: [second] }, renderInterface, post, title);
    expect(root.querySelector('details.block-section')).toBeNull();
    commit(root.querySelector<HTMLInputElement>('input[aria-label="Name of Count"]')!, 'Calls');
    expect(sent.at(-1)).not.toHaveProperty('block');
    root.remove();
  });
});

// SimaticML exports are shown read-only (ADR 0014): nothing in the tables can be changed.
describe('read-only tables (SimaticML)', () => {
  const editable = (root: HTMLElement) =>
    [...root.querySelectorAll('input, button')].filter(
      (e) => !(e as HTMLInputElement).disabled && e.textContent !== 'Open text',
    );

  it('shows an interface without anything to edit, with the read-only note', async () => {
    const { root, sent, post } = setup();
    const ro: InterfaceModel = {
      ...iface,
      format: 'simaticml',
      readOnly: true,
      sections: iface.sections.map((s) => ({
        ...s,
        canAdd: false,
        rows: s.rows.map((r) => ({ ...r, declarationEditable: false })),
      })),
    };
    renderInterface(root, ro, post);
    expect(root.querySelector('.banner.readonly')?.textContent).toMatch(
      /read-only and not checked/,
    );
    expect(editable(root)).toEqual([]);
    expect(root.querySelector('table')?.textContent).toContain('Enable it');
    expect(await accessibilityViolations(root)).toEqual([]);
    expect(sent).toEqual([]);
    root.remove();
  });

  it('shows a data block without anything to edit', async () => {
    const { root, post } = setup();
    const model: DataBlockModel = {
      view: 'datablock',
      blockName: 'DB_X',
      dbKind: 'global',
      instanceOf: '',
      format: 'simaticml',
      readOnly: true,
      failsafe: false,
      culture: 'en-US',
      rows: [
        row('Speed', { value: '5', declarationEditable: false }),
        row('Path', { type: 'Array[0..1] of Real', structured: true, declarationEditable: false }),
        row('Path[0]', {
          path: ['Path[0]'],
          level: 1,
          type: 'Real',
          value: '1.5',
          declarationEditable: false,
        }),
      ],
      types: [],
    };
    renderDataBlock(root, model, post);
    expect(root.querySelector('.banner.readonly')).not.toBeNull();
    expect(editable(root)).toEqual([]);
    expect(root.querySelector('table')?.textContent).toContain('1.5');
    expect(await accessibilityViolations(root)).toEqual([]);
    root.remove();
  });
});

describe('data block editor', () => {
  it('keeps the interface of an instance DB read-only and start values editable', async () => {
    const { root, sent, post } = setup();
    const model: DataBlockModel = {
      view: 'datablock',
      blockName: 'IDB_X',
      dbKind: 'instance',
      instanceOf: 'FB_X',
      format: 's7dcl',
      failsafe: false,
      culture: 'en-US',
      rows: [
        row('Mode', {
          declarationEditable: false,
          value: '2',
          defaultValue: '0',
          problems: ['40000 is outside the range of Int.'],
        }),
      ],
      types: [],
    };
    renderDataBlock(root, model, post);
    expect(await accessibilityViolations(root)).toEqual([]);
    // an instance DB has no + inside structs: its declarations belong to the FB
    expect(root.querySelector('[aria-label^="Add a member to"]')).toBeNull();
    expect(root.querySelector('[aria-label="Name of Mode"]')).toBeNull();
    expect(root.textContent).toContain('instance DB of FB_X');
    expect(root.querySelector('tr.has-problem')).not.toBeNull();
    commit(root.querySelector<HTMLInputElement>('[aria-label="Start value of Mode"]')!, '3');
    expect(sent).toEqual([{ type: 'edit', op: 'start', path: ['Mode'], value: '3' }]);
  });
});

describe('data block editor, structs', () => {
  it('adds a member inside a struct of a global DB', () => {
    const { root, sent, post } = setup();
    const model: DataBlockModel = {
      view: 'datablock',
      blockName: 'DB_M',
      dbKind: 'global',
      instanceOf: '',
      format: 's7dcl',
      failsafe: false,
      culture: 'en-US',
      rows: [
        row('Limits', { type: 'Struct', structured: true }),
        row('Min', { path: ['Limits', 'Min'], level: 1, type: 'Real' }),
        row('Count'),
      ],
      types: [],
    };
    renderDataBlock(root, model, post);
    root.querySelector<HTMLButtonElement>('[aria-label="Add a member to Limits"]')!.click();
    const name = root.querySelector<HTMLInputElement>('[aria-label="New member name in Limits"]')!;
    expect(
      name.closest('tr')!.nextElementSibling?.querySelector('[aria-label="Name of Count"]'),
    ).not.toBeNull();
    commit(name, 'Max');
    commit(
      root.querySelector<HTMLInputElement>('[aria-label="New member data type in Limits"]')!,
      'Real',
    );
    expect(sent).toMatchObject([{ op: 'add', section: 'Static', name: 'Max', parent: ['Limits'] }]);
  });
});

describe('array data block', () => {
  it('edits the start value of an element (corpus C40)', () => {
    const { root, sent, post } = setup();
    const element = (i: number, value: string) =>
      row(`THIS[${i}]`, { name: `[${i}]`, value, declarationEditable: false });
    renderDataBlock(
      root,
      {
        view: 'datablock',
        blockName: 'DB_V2_Array',
        dbKind: 'array',
        instanceOf: '',
        format: 's7dcl',
        failsafe: false,
        culture: 'en-US',
        rows: [element(0, ''), element(1, '5')],
        types: [],
      },
      post,
    );
    commit(root.querySelector<HTMLInputElement>('[aria-label="Start value of THIS[0]"]')!, '2');
    expect(sent).toEqual([{ type: 'edit', op: 'start', path: ['THIS[0]'], value: '2' }]);
  });
});

describe('translation table', () => {
  it('shows one column per language and highlights missing translations', async () => {
    const { root, sent, post } = setup();
    const model: TranslationModel = {
      view: 'translations',
      blockName: 'FB_X',
      failsafe: false,
      cultures: ['de-DE', 'en-US'],
      culture: 'en-US',
      rows: [
        {
          id: 'MLC_1',
          context: 'Enable',
          texts: { 'de-DE': 'Freigabe', 'en-US': 'Enable' },
          missing: [],
          start: 0,
          end: 1,
        },
        {
          id: 'MLC_2',
          context: 'Network 1 title',
          texts: { 'de-DE': '', 'en-US': 'Start' },
          missing: ['de-DE'],
          start: 0,
          end: 1,
        },
      ],
    };
    renderTranslations(root, model, post);
    expect(await accessibilityViolations(root)).toEqual([]);
    expect([...root.querySelectorAll('th')].map((t) => t.textContent)).toEqual([
      'Text id',
      'Used by',
      'de-DE',
      'en-US',
    ]);
    expect(root.querySelectorAll('td.missing')).toHaveLength(1);
    commit(
      root.querySelector<HTMLInputElement>('[aria-label="de-DE text of Network 1 title"]')!,
      'Anlauf',
    );
    expect(sent).toEqual([
      { type: 'edit', op: 'text', id: 'MLC_2', culture: 'de-DE', value: 'Anlauf' },
    ]);
  });
});

describe('tag table editor', () => {
  it('edits tags and constants, keeps system constants read-only, shows address problems', async () => {
    const { root, sent, post } = setup();
    const model: TagTableModel = {
      view: 'tagtable',
      name: 'Tags_IO',
      family: 'S7-1200',
      cultures: ['de-DE', 'en-US'],
      culture: 'en-US',
      rows: [
        {
          kind: 'tag',
          name: 'Start',
          dataType: 'Int',
          address: '%I0.0',
          value: '',
          accessible: true,
          visible: true,
          writable: true,
          comments: { 'en-US': 'Start button' },
          problems: [{ severity: 'warning', message: 'Int needs a word address, not %I0.0.' }],
          start: 0,
          end: 1,
        },
        {
          kind: 'constant',
          name: 'MAX',
          dataType: 'Int',
          address: '',
          value: '1000',
          accessible: true,
          visible: true,
          writable: true,
          comments: {},
          problems: [],
          start: 0,
          end: 1,
        },
        {
          kind: 'systemConstant',
          name: 'Local~CPU',
          dataType: 'Hw_Device',
          address: '',
          value: '32',
          accessible: true,
          visible: true,
          writable: true,
          comments: {},
          problems: [],
          start: 0,
          end: 1,
        },
      ],
    };
    renderTagTable(root, model, post);
    expect(await accessibilityViolations(root)).toEqual([]);
    expect(root.querySelector('tr.has-problem')?.textContent).toContain('word address');
    expect(root.querySelector('[aria-label="Name of Local~CPU"]')).toBeNull();
    commit(root.querySelector<HTMLInputElement>('[aria-label="Address of Start"]')!, '%IW0');
    commit(root.querySelector<HTMLInputElement>('[aria-label="Value of MAX"]')!, '2000');
    root
      .querySelector<HTMLInputElement>('[aria-label="Writable from HMI/OPC UA of Start"]')!
      .click();
    expect(sent.map((m) => [m['op'], m['name'], m['value'] ?? null])).toEqual([
      ['address', 'Start', '%IW0'],
      ['value', 'MAX', '2000'],
      ['flag', 'Start', false],
    ]);
  });
});

describe('program graph', () => {
  it('lays out a 5,000-block program quickly', () => {
    const model = syntheticGraph(5000);
    const t0 = performance.now();
    const f = filterGraph(model, { ob: '', unit: '', instances: false, search: '' });
    const placed = layoutGraph(f.nodes, f.edges);
    const ms = performance.now() - t0;
    expect(placed).toHaveLength(5000);
    expect(ms).toBeLessThan(1500);
    // callers are left of the blocks they call (except cycle edges)
    const byId = new Map(placed.map((n) => [n.id, n]));
    const forward = f.edges.filter((e) => byId.get(e.from)!.layer < byId.get(e.to)!.layer).length;
    expect(forward / f.edges.length).toBeGreaterThan(0.95);
  });

  it('filters by OB, unit and search', () => {
    const model = syntheticGraph(200);
    const all = filterGraph(model, { ob: '', unit: '', instances: false, search: '' }).nodes.length;
    expect(
      filterGraph(model, { ob: 'b0', unit: '', instances: false, search: '' }).nodes.length,
    ).toBe(all);
    expect(
      filterGraph(model, { ob: '', unit: 'Unit_A', instances: false, search: '' }).nodes.every(
        (n) => n.unit === 'Unit_A',
      ),
    ).toBe(true);
    expect(
      filterGraph(model, { ob: '', unit: '', instances: false, search: 'FC_9' }).nodes.length,
    ).toBeLessThan(all);
  });

  it('renders the canvas and an accessible list, and opens blocks', async () => {
    const { root, sent, post } = setup();
    root.style.width = '800px';
    root.style.height = '600px';
    const view = createGraphView(root, post);
    view.update(syntheticGraph(50));
    expect(view.placed()).toHaveLength(50);
    expect(await accessibilityViolations(root)).toEqual([]);
    const items = root.querySelectorAll('.graph-list button');
    expect(items.length).toBe(50);
    items[0]!.dispatchEvent(new MouseEvent('dblclick'));
    expect(sent).toEqual([{ type: 'open', path: '/p/OB_0.s7dcl' }]);
    expect(root.querySelector('canvas')?.getAttribute('aria-label')).toMatch(/Arrow keys pan/);
  });
});
