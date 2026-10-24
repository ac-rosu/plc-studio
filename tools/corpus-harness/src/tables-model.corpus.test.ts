// Models of the table editors (spec M7) on corpus exports, and the cycle edit, apply, parse again.
import {
  Project,
  SourceText,
  applyEdits,
  parseBlockText,
  setStartValue,
  type EditResult,
} from '@plcstudio/core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  blockContext,
  dataBlockModel,
  declarationEdit,
  interfaceModel,
  translationEdit,
  translationModel,
  type BlockContext,
  type ModelInput,
  type Row,
} from '../../../packages/extension/src/features/tables-model.ts';

const root = fileURLToPath(new URL('../../../corpus/V21', import.meta.url));

const read = (file: string): string =>
  SourceText.fromBytes(new Uint8Array(readFileSync(file))).text;

/** Exported files of the given cases, by project path. */
function files(cases: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of cases) {
    const dir = `${root}/${c}/documents`;
    for (const f of readdirSync(dir)) out.set(`/plc/${f}`, read(`${dir}/${f}`));
  }
  return out;
}

function project(texts: Map<string, string>): Project {
  const p = new Project('/plc');
  p.setManifest(
    '/plc/plc.json',
    JSON.stringify({ name: 'P', cpu: { family: 'S7-1500', failsafe: true }, tiaVersion: 'V21' }),
  );
  for (const [path, text] of texts) p.setFile(path, new SourceText(text));
  return p;
}

function input(p: Project, path: string, culture = 'en-US'): ModelInput {
  return { project: p, path, cultures: ['de-DE', 'en-US'], culture, diagnostics: [] };
}

function context(p: Project, path: string): BlockContext {
  const c = blockContext(input(p, path));
  if (typeof c === 'string') throw new Error(c);
  return c;
}

/** Applies an edit result to the texts, as the extension does with one WorkspaceEdit. */
function apply(
  texts: Map<string, string>,
  path: string,
  result: EditResult | undefined,
): Map<string, string> {
  if (!result) throw new Error('no edit');
  if (result.error) throw new Error(result.error);
  const next = new Map(texts);
  next.set(path, applyEdits(texts.get(path)!, result.edits));
  const resPath = path.replace(/\.[^./]+$/, '.s7res');
  if (result.resourceEdits)
    next.set(resPath, applyEdits(texts.get(resPath)!, result.resourceEdits));
  if (result.newResourceText !== undefined) next.set(resPath, result.newResourceText);
  for (const [other, edits] of result.otherFiles ?? [])
    next.set(other, applyEdits(texts.get(other)!, edits));
  return next;
}

const row = (rows: readonly Row[], path: string): Row => {
  const r = rows.find((x) => x.path.join('.') === path);
  if (!r) throw new Error(`no row ${path}`);
  return r;
};

describe('data block editor model', () => {
  const texts = files(['C01-udts', 'C02-global-db']);
  const db = '/plc/DB_Machine.s7dcl';

  it('reads start values, flags and comments of a global DB', () => {
    const m = dataBlockModel(input(project(texts), db));
    expect(m.error).toBeUndefined();
    expect(m.dbKind).toBe('global');
    expect(row(m.rows, 'MachineOn')).toMatchObject({
      value: 'FALSE',
      retain: false,
      comment: 'Machine switched on',
      declarationEditable: true,
    });
    expect(row(m.rows, 'OperatingHours').retain).toBe(true);
    expect(row(m.rows, 'InternalState')).toMatchObject({
      visible: false,
      writable: false,
      accessible: false,
    });
    expect(row(m.rows, 'ReadOnlyValue')).toMatchObject({
      visible: true,
      writable: false,
      accessible: true,
    });
    expect(row(m.rows, 'SpeedSetpoint').setpoint).toBe(true);
    expect(row(m.rows, 'Limits').structured).toBe(true);
    expect(row(m.rows, 'Limits.Minimum').value).toBe('0.0');
    expect(row(m.rows, 'Speeds[2]').value).toBe('20');
    expect(row(m.rows, 'MainMotor').structured).toBe(true);
    expect(m.rows.filter((r) => r.path[0] === 'MainMotor').length).toBeGreaterThan(1);
    expect(m.rows.every((r) => r.problems.length === 0)).toBe(true);
  });

  it('shows comments in the display language', () => {
    const m = dataBlockModel(input(project(texts), db, 'de-DE'));
    expect(row(m.rows, 'MachineOn').comment).toBe('Maschine eingeschaltet');
  });

  it('changes a start value and reads it back', () => {
    const p = project(texts);
    const next = apply(
      texts,
      db,
      declarationEdit(context(p, db), {
        type: 'edit',
        op: 'start',
        path: ['PieceCount'],
        value: '5',
      }),
    );
    expect(row(dataBlockModel(input(project(next), db)).rows, 'PieceCount').value).toBe('5');
    expect(next.get(db)!.split('\r\n').length).toBe(texts.get(db)!.split('\r\n').length);
  });

  it('changes an array element start value', () => {
    const p = project(texts);
    const next = apply(
      texts,
      db,
      declarationEdit(context(p, db), {
        type: 'edit',
        op: 'start',
        path: ['Speeds[3]'],
        value: '33',
      }),
    );
    expect(row(dataBlockModel(input(project(next), db)).rows, 'Speeds[3]').value).toBe('33');
  });

  it('refuses a start value out of range', () => {
    const result = declarationEdit(context(project(texts), db), {
      type: 'edit',
      op: 'start',
      path: ['PieceCount'],
      value: '70000',
    });
    expect(result?.error).toBeTruthy();
  });

  it('sets HMI flags and retain, and reads them back', () => {
    let current = texts;
    const step = (message: Record<string, unknown>) => {
      current = apply(
        current,
        db,
        declarationEdit(context(project(current), db), { type: 'edit', ...message }),
      );
    };
    step({ op: 'flag', path: ['MachineOn'], flag: 'writable', value: false });
    step({ op: 'flag', path: ['InternalState'], flag: 'visible', value: true });
    step({ op: 'flag', path: ['PieceCount'], flag: 'retain', value: true });
    const m = dataBlockModel(input(project(current), db));
    expect(row(m.rows, 'MachineOn')).toMatchObject({ writable: false, visible: true });
    expect(row(m.rows, 'InternalState')).toMatchObject({ visible: true, writable: false });
    expect(row(m.rows, 'PieceCount')).toMatchObject({ retain: true, value: '0' });
  });

  it('adds a member with a translated comment and deletes it again', () => {
    const p = project(texts);
    const added = apply(
      texts,
      db,
      declarationEdit(context(p, db), {
        type: 'edit',
        op: 'add',
        section: 'Static',
        name: 'NewValue',
        typeText: 'Int',
        comment: 'New value',
      }),
    );
    const m = dataBlockModel(input(project(added), db));
    expect(row(m.rows, 'NewValue')).toMatchObject({ type: 'Int', comment: 'New value' });
    const removed = apply(
      added,
      db,
      declarationEdit(context(project(added), db), {
        type: 'edit',
        op: 'delete',
        path: ['NewValue'],
      }),
    );
    expect(removed.get(db)).toBe(texts.get(db));
    expect(removed.get('/plc/DB_Machine.s7res')).toBe(texts.get('/plc/DB_Machine.s7res'));
  });

  it('adds a member inside a struct and deletes it again, byte for byte', () => {
    const p = project(texts);
    const added = apply(
      texts,
      db,
      declarationEdit(context(p, db), {
        type: 'edit',
        op: 'add',
        section: 'Static',
        parent: ['Limits'],
        name: 'Nominal',
        typeText: 'Real',
        comment: 'Nominal value',
      }),
    );
    expect(added.get(db)).toContain('            Maximum : Real;\r\n            { S7_MLC := ');
    const m = dataBlockModel(input(project(added), db));
    expect(row(m.rows, 'Limits.Nominal')).toMatchObject({
      type: 'Real',
      level: 1,
      comment: 'Nominal value',
    });
    const removed = apply(
      added,
      db,
      declarationEdit(context(project(added), db), {
        type: 'edit',
        op: 'delete',
        path: ['Limits', 'Nominal'],
      }),
    );
    expect(removed.get(db)).toBe(texts.get(db));
    expect(removed.get('/plc/DB_Machine.s7res')).toBe(texts.get('/plc/DB_Machine.s7res'));
  });

  it('adds and deletes a struct member in the external source of the same DB', () => {
    const path = '/plc/DB_Machine.db';
    const source = new Map([[path, read(`${root}/C02-global-db/source/DB_Machine.db`)]]);
    const added = apply(
      source,
      path,
      declarationEdit(context(project(source), path), {
        type: 'edit',
        op: 'add',
        section: 'Static',
        parent: ['Limits'],
        name: 'Nominal',
        typeText: 'Real',
        comment: 'Nominal value',
      }),
    );
    expect(added.get(path)).toContain(
      '         Maximum : Real;   // Upper limit\r\n         Nominal : Real;   // Nominal value\r\n      END_STRUCT;',
    );
    const removed = apply(
      added,
      path,
      declarationEdit(context(project(added), path), {
        type: 'edit',
        op: 'delete',
        path: ['Limits', 'Nominal'],
      }),
    );
    expect(removed.get(path)).toBe(source.get(path));
  });

  it('changes a comment in one language only', () => {
    const p = project(texts);
    const next = apply(
      texts,
      db,
      declarationEdit(context(p, db), {
        type: 'edit',
        op: 'comment',
        path: ['MachineOn'],
        culture: 'en-US',
        value: 'Machine is on',
      }),
    );
    expect(next.get(db)).toBe(texts.get(db));
    expect(row(dataBlockModel(input(project(next), db)).rows, 'MachineOn').comment).toBe(
      'Machine is on',
    );
    expect(row(dataBlockModel(input(project(next), db, 'de-DE')).rows, 'MachineOn').comment).toBe(
      'Maschine eingeschaltet',
    );
  });
});

describe('instance DB model', () => {
  const texts = files(['C05-scl-sections', 'C11-idb-start-values']);
  const idb = '/plc/IDB_SclSections.s7dcl';

  it('lists the FB interface with the start values of the instance', () => {
    const m = dataBlockModel(input(project(texts), idb));
    expect(m.dbKind).toBe('instance');
    expect(m.instanceOf).toContain('FB_SclSections');
    expect(row(m.rows, 'Enable')).toMatchObject({
      value: 'TRUE',
      declarationEditable: false,
      comment: 'Enable the evaluation',
    });
    expect(row(m.rows, 'Mode').value).toBe('2');
    expect(row(m.rows, 'Result').value).toBe('');
    expect(m.rows.some((r) => r.name === 'Index')).toBe(false);
  });

  it('adds a start value to an instance DB', () => {
    const p = project(texts);
    const next = apply(
      texts,
      idb,
      declarationEdit(context(p, idb), {
        type: 'edit',
        op: 'start',
        path: ['Result'],
        value: '1.5',
      }),
    );
    expect(row(dataBlockModel(input(project(next), idb)).rows, 'Result').value).toBe('1.5');
  });
});

describe('interface editor model', () => {
  const texts = files(['C05-scl-sections']);
  const fb = '/plc/FB_SclSections.s7dcl';

  it('lists every section of an FB', () => {
    const m = interfaceModel(input(project(texts), fb));
    expect(m.error).toBeUndefined();
    expect(m.blockKind).toBe('FB');
    expect(m.sections.map((s) => [s.kind, s.rows.length])).toEqual([
      ['Input', 3],
      ['Output', 3],
      ['InOut', 1],
      ['Static', 3],
      ['Temp', 3],
      ['Constant', 5],
    ]);
    const constant = m.sections.find((s) => s.kind === 'Constant')!;
    expect(row(constant.rows, 'MAXIMUM_INDEX')).toMatchObject({ type: 'Int', value: '9' });
    expect(m.types).toContain('Int');
  });

  it('renames a member in the declaration and in the code', () => {
    const p = project(texts);
    const next = apply(
      texts,
      fb,
      declarationEdit(context(p, fb), {
        type: 'edit',
        op: 'rename',
        path: ['Iterations'],
        value: 'LoopCount',
      }),
    );
    expect(next.get(fb)).not.toMatch(/\bIterations\b/);
    expect(next.get(fb)).toMatch(/LoopCount : Int;/);
    const m = interfaceModel(input(project(next), fb));
    expect(m.sections.find((s) => s.kind === 'Static')!.rows.map((r) => r.name)).toContain(
      'LoopCount',
    );
  });

  it('changes a type and moves a member', () => {
    let current = texts;
    current = apply(
      current,
      fb,
      declarationEdit(context(project(current), fb), {
        type: 'edit',
        op: 'type',
        path: ['Mode'],
        value: 'DInt',
      }),
    );
    current = apply(
      current,
      fb,
      declarationEdit(context(project(current), fb), {
        type: 'edit',
        op: 'move',
        path: ['Mode'],
        direction: -1,
      }),
    );
    const inputs = interfaceModel(input(project(current), fb)).sections.find(
      (s) => s.kind === 'Input',
    )!.rows;
    expect(inputs.map((r) => [r.name, r.type])).toEqual([
      ['Mode', 'DInt'],
      ['Enable', 'Bool'],
      ['Setpoint', 'Real'],
    ]);
  });

  it('changes the return type of a function and back, in both formats', () => {
    const sd = files(['C06-scl-types']);
    const fc = '/plc/FC_SclTypes.s7dcl';
    const changed = apply(
      sd,
      fc,
      declarationEdit(context(project(sd), fc), { type: 'edit', op: 'returnType', value: 'LReal' }),
    );
    expect(changed.get(fc)).toContain('FUNCTION "FC_SclTypes" : LReal');
    const model = interfaceModel(input(project(changed), fc));
    expect(model.sections.find((s) => s.kind === 'Return')!.returnType).toBe('LReal');
    const back = apply(
      changed,
      fc,
      declarationEdit(context(project(changed), fc), {
        type: 'edit',
        op: 'returnType',
        value: 'Real',
      }),
    );
    expect(back.get(fc)).toBe(sd.get(fc));
    const scl = '/plc/FC_SclTypes.scl';
    const source = new Map([[scl, read(`${root}/C06-scl-types/source/FC_SclTypes.scl`)]]);
    const voided = apply(
      source,
      scl,
      declarationEdit(context(project(source), scl), {
        type: 'edit',
        op: 'returnType',
        value: 'Void',
      }),
    );
    // the BOM is kept by SourceText, outside the text
    expect(voided.get(scl)!.split('\r\n')[0]).toBe('FUNCTION "FC_SclTypes" : Void');
  });

  it('marks fail-safe blocks', () => {
    const f = files(['C24-failsafe']);
    expect(interfaceModel(input(project(f), '/plc/F_FB_MainSafety.s7dcl')).failsafe).toBe(true);
    expect(interfaceModel(input(project(texts), fb)).failsafe).toBe(false);
  });
});

describe('translation table model', () => {
  const texts = files(['C02-global-db']);
  const db = '/plc/DB_Machine.s7dcl';

  it('lists every text with its languages', () => {
    const m = translationModel(input(project(texts), db));
    expect(m.cultures).toEqual(['de-DE', 'en-US']);
    const first = m.rows.find((r) => r.id === 'MLC_3yS')!;
    expect(first).toMatchObject({
      context: 'MachineOn',
      texts: { 'de-DE': 'Maschine eingeschaltet', 'en-US': 'Machine switched on' },
      missing: [],
    });
    expect(m.rows.find((r) => r.id === 'MLC_4LN')!.context).toBe('Limits.Minimum');
  });

  it('edits one translation', () => {
    const p = project(texts);
    const next = apply(
      texts,
      db,
      translationEdit(context(p, db), {
        type: 'edit',
        op: 'text',
        id: 'MLC_3yS',
        culture: 'de-DE',
        value: 'Maschine an',
      }),
    );
    expect(next.get(db)).toBe(texts.get(db));
    const m = translationModel(input(project(next), db));
    expect(m.rows.find((r) => r.id === 'MLC_3yS')!.texts).toEqual({
      'de-DE': 'Maschine an',
      'en-US': 'Machine switched on',
    });
  });

  it('refuses external sources', () => {
    const p = new Project('/plc');
    p.setManifest(
      '/plc/plc.json',
      JSON.stringify({ name: 'P', cpu: { family: 'S7-1500' }, tiaVersion: 'V21' }),
    );
    p.setFile(
      '/plc/DB_Machine.db',
      new SourceText(read(`${root}/C02-global-db/source/DB_Machine.db`)),
    );
    expect(translationModel(input(p, '/plc/DB_Machine.db')).error).toBeTruthy();
  });
});

describe('array DB start values (corpus C40, C03)', () => {
  const start = (texts: Map<string, string>, path: string, element: string, value: string) =>
    apply(
      texts,
      path,
      declarationEdit(context(project(texts), path), {
        type: 'edit',
        op: 'start',
        path: [element],
        value,
      }),
    );

  it('shows THIS[i] values, edits them, and a removed value comes back byte for byte', () => {
    const texts = files(['C40-array-db-start-values']);
    const db = '/plc/DB_V2_Array.s7dcl';
    const m = dataBlockModel(input(project(texts), db));
    expect(m.dbKind).toBe('array');
    expect(m.rows.map((r) => [r.name, r.value, r.structured])).toEqual([
      ['[0]', '', false],
      ['[1]', '5', false],
      ['[2]', '', false],
      ['[3]', '-7', false],
    ]);
    const removed = start(texts, db, 'THIS[3]', '');
    expect(removed.get(db)).not.toContain('THIS[3]');
    expect(start(removed, db, 'THIS[3]', '-7').get(db)).toBe(texts.get(db));
  });

  it('writes the first value of an array DB where TIA puts it, in both formats', () => {
    const texts = files(['C03-array-db']);
    const db = '/plc/DB_Recipes.s7dcl';
    // elements of a PLC data type stay read-only: no sample shows their start values yet
    expect(dataBlockModel(input(project(texts), db)).rows.every((r) => r.structured)).toBe(true);
    const fileOf = (t: string, format: 's7dcl' | 'source') => parseBlockText(t, format);
    const sd = fileOf(texts.get(db)!, 's7dcl');
    const sdNext = applyEdits(
      texts.get(db)!,
      setStartValue(sd, sd.blocks[0]!, 'THIS[2]', '1').edits,
    );
    expect(sdNext.split('\r\n').slice(5, 9)).toEqual([
      'DATA_BLOCK DB_Recipes : Array[0..9] of _.UDT_Recipe',
      '    THIS[2] := 1;',
      '',
      'END_DATA_BLOCK',
    ]);
    const c40 = read(`${root}/C40-array-db-start-values/source/DB_V2_Array.db`);
    const src = fileOf(c40, 'source');
    const without = applyEdits(c40, setStartValue(src, src.blocks[0]!, 'THIS[1]', undefined).edits);
    const back = fileOf(without, 'source');
    expect(applyEdits(without, setStartValue(back, back.blocks[0]!, 'THIS[1]', '5').edits)).toBe(
      c40,
    );
  });
});
