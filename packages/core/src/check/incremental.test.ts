// Incremental analysis (M2.9, M6.8): what is bound again after each kind of change, and that the
// result always equals a fresh analysis of the same texts.
import { describe, expect, it } from 'vitest';
// the index registers the analyzer passes, so their per-block cache is exercised too
import { analyzeProject, Project, type ProjectAnalysis } from '../index.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

const scl = (keyword: string, name: string, decl: string[], body: string[], end: string) =>
  crlf(
    '{',
    '    S7_EditorMode := "SCL"',
    '}',
    `${keyword} "${name}"${keyword === 'FUNCTION' ? ' : Void' : ''}`,
    ...decl,
    '    { S7_Language := "SCL" }',
    '    NETWORK',
    '        ',
    ...body.map((l) => '            ' + l),
    '        ',
    '    END_NETWORK',
    end,
  );
const fb = (name: string, decl: string[], body: string[]) =>
  scl('FUNCTION_BLOCK', name, decl, body, 'END_FUNCTION_BLOCK');
const fc = (name: string, decl: string[], body: string[]) =>
  scl('FUNCTION', name, decl, body, 'END_FUNCTION');
const ob = (name: string, decl: string[], body: string[]) =>
  scl('ORGANIZATION_BLOCK', name, decl, body, 'END_ORGANIZATION_BLOCK');

const udt = (extra: string[] = []) =>
  crlf(
    'TYPE',
    '    UDT_Motor : STRUCT',
    '        Speed : Real;',
    '        On : Bool;',
    ...extra,
    '    END_STRUCT;',
    'END_TYPE',
  );
const scale = (inputs: string[] = [], body = '#Out := #In * 2;') =>
  fc(
    'FC_Scale',
    ['    VAR_INPUT', '        In : Int;', ...inputs, '    END_VAR'].concat([
      '    VAR_OUTPUT',
      '        Out : Int;',
      '    END_VAR',
    ]),
    [body],
  );
const dataBlock = (extra: string[] = []) =>
  crlf(
    'DATA_BLOCK DB_Data',
    '    VAR',
    '        Count : Int;',
    ...extra,
    '    END_VAR',
    '',
    'END_DATA_BLOCK',
  );
const tags = (address: string) => `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Tags.PlcTagTable ID="0">
    <AttributeList>
      <Name>Tags</Name>
    </AttributeList>
    <ObjectList>
      <SW.Tags.PlcTag ID="1" CompositionName="Tags">
        <AttributeList>
          <DataTypeName>Bool</DataTypeName>
          <LogicalAddress>${address}</LogicalAddress>
          <Name>StartButton</Name>
        </AttributeList>
      </SW.Tags.PlcTag>
    </ObjectList>
  </SW.Tags.PlcTagTable>
</Document>`;

function files(): Record<string, string> {
  return {
    'UDT_Motor.s7dcl': udt(),
    'FB_Motor.s7dcl': fb(
      'FB_Motor',
      [
        '    VAR_INPUT',
        '        Start : Bool;',
        '    END_VAR',
        '    VAR_OUTPUT',
        '        Running : Bool;',
        '    END_VAR',
        '    VAR',
        '        Data : _.UDT_Motor;',
        '        Spare : Int;',
        '    END_VAR',
      ],
      ['#Running := #Start AND #Data.On;'],
    ),
    'IDB_Motor.s7dcl': crlf('DATA_BLOCK IDB_Motor : FB_Motor', 'END_DATA_BLOCK'),
    'FC_Scale.s7dcl': scale(),
    'FB_Line.s7dcl': fb(
      'FB_Line',
      ['    VAR', '        Motor : FB_Motor;', '        Value : Int;', '    END_VAR'],
      ['#Motor(Start := TRUE);', '"FC_Scale"(In := 1, Out => #Value);'],
    ),
    'DB_Data.s7dcl': dataBlock(),
    'FB_Other.s7dcl': fb(
      'FB_Other',
      ['    VAR_OUTPUT', '        Copy : Int;', '    END_VAR'],
      ['#Copy := "DB_Data".Count;'],
    ),
    'FC_Tags.s7dcl': fc(
      'FC_Tags',
      ['    VAR_OUTPUT', '        Pressed : Bool;', '    END_VAR'],
      ['#Pressed := "StartButton";'],
    ),
    'OB_Main.s7dcl': ob(
      'OB_Main',
      ['    VAR_TEMP', '        Scaled : Int;', '    END_VAR'],
      ['"IDB_Motor"(Start := "StartButton");', '"FC_Scale"(In := 2, Out => #Scaled);'],
    ),
    'Tags.xml': tags('%I0.0'),
  };
}

const readsSpare = () =>
  fb(
    'FB_Other',
    ['    VAR_OUTPUT', '        Copy : Int;', '    END_VAR'],
    ['#Copy := "IDB_Motor".Spare;'],
  );

const MANIFEST = { name: 'P', cpu: { family: 'S7-1500' }, tiaVersion: 'V21' };

function project(texts = files(), manifest: object = MANIFEST): Project {
  const p = new Project('/plc');
  p.setManifest('/plc/plc.json', JSON.stringify(manifest));
  for (const [name, text] of Object.entries(texts)) p.setFileText(`/plc/${name}`, text);
  return p;
}

/** Names of the blocks bound in `next` (the others share their binding with `prev`). */
function rebound(prev: ProjectAnalysis, next: ProjectAnalysis): string[] {
  return [...next.blocks.values()]
    .filter((b) => prev.blocks.get(b.symbol.id)?.references !== b.references)
    .map((b) => b.symbol.name)
    .sort();
}

/** Everything a consumer sees, in order: diagnostics per file and references per symbol. */
function snapshot(p: Project) {
  const a = analyzeProject(p);
  const diagnostics = [...a.diagnostics]
    .map(([file, list]) => [
      file,
      list.map((d) => [d.range.start, d.range.end, d.severity, d.code, d.message]),
    ])
    .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  const references = [...a.referencesBySymbol]
    .map(([id, list]) => [
      id,
      list.map((r) => [r.file, r.range.start, r.range.end, r.access, r.blockId]),
    ])
    .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  const calls = a.calls.map((c) => [c.callerId, c.file, c.range.start, c.calleeId, c.kind]);
  return { diagnostics, references, calls, flat: a.references.length };
}

/** A fresh project with the same files, added in the same order, and the same settings. */
function fresh(p: Project): Project {
  const q = new Project(p.root);
  if (p.manifestPath && p.manifestText !== undefined) q.setManifest(p.manifestPath, p.manifestText);
  if (p.rulesPath && p.rulesText !== undefined) q.setRules(p.rulesPath, p.rulesText);
  for (const f of p.files.values()) q.setFileText(f.path, f.source.text);
  return q;
}

describe('incremental analysis', () => {
  it('a body edit binds only the blocks of that file', () => {
    const p = project();
    const first = analyzeProject(p);
    expect(first.stats.full).toBe(true);
    const all = first.blocks.size;
    p.setFileText('/plc/FC_Scale.s7dcl', scale([], '#Out := #In * 3;'));
    const next = analyzeProject(p);
    expect(next.stats).toMatchObject({
      full: false,
      extractedFiles: 1,
      boundBlocks: 1,
      reusedBlocks: all - 1,
    });
    expect(rebound(first, next)).toEqual(['FC_Scale']);
    expect(next.stats.analyzedBlocks).toBeLessThan(all);
  });

  it('an interface edit binds the block and the blocks that use it', () => {
    const p = project();
    const first = analyzeProject(p);
    p.setFileText('/plc/FC_Scale.s7dcl', scale(['        Gain : Int;']));
    const next = analyzeProject(p);
    expect(rebound(first, next)).toEqual(['FB_Line', 'FC_Scale', 'OB_Main']);
    // the callers now miss the new parameter
    const missing = [...next.diagnostics.values()]
      .flat()
      .filter((d) => d.code === 'missing-fc-parameter');
    expect(missing).toHaveLength(2);
  });

  it('a type edit binds every block whose declarations use the type, and their users', () => {
    const p = project();
    const first = analyzeProject(p);
    p.setFileText('/plc/UDT_Motor.s7dcl', udt(['        Fault : Bool;']));
    const next = analyzeProject(p);
    expect(rebound(first, next)).toEqual([
      'FB_Line',
      'FB_Motor',
      'IDB_Motor',
      'OB_Main',
      'UDT_Motor',
    ]);
  });

  it('a tag table edit binds the blocks that use its tags', () => {
    const p = project();
    const first = analyzeProject(p);
    p.setFileText('/plc/Tags.xml', tags('%I0.1'));
    const next = analyzeProject(p);
    expect(rebound(first, next)).toEqual(['FC_Tags', 'OB_Main']);
  });

  it('analyzer findings follow references from blocks that were not bound again', () => {
    const p = project();
    const unusedSpare = () =>
      [...analyzeProject(p).diagnostics.values()]
        .flat()
        .filter((d) => d.code === 'unused-static' && d.message.includes('#Spare'));
    expect(unusedSpare()).toHaveLength(1);
    // FB_Other starts reading the static through the instance DB: FB_Motor is not bound again,
    // but its single-block rules run again because a reference to one of its members changed
    p.setFileText('/plc/FB_Other.s7dcl', readsSpare());
    expect(unusedSpare()).toEqual([]);
    expect(analyzeProject(p).stats.boundBlocks).toBe(1);
  });

  it('manifest and rules changes, and added or removed names, bind everything', () => {
    const p = project();
    analyzeProject(p);
    const all = analyzeProject(p).blocks.size;
    p.setManifest('/plc/plc.json', JSON.stringify({ ...MANIFEST, compiler: { iecCheck: true } }));
    expect(analyzeProject(p).stats).toMatchObject({ full: true, boundBlocks: all });
    p.setRules('/plc/plcstudio.rules.json', JSON.stringify({ rules: { 'unused-temp': 'off' } }));
    expect(analyzeProject(p).stats).toMatchObject({ full: true, boundBlocks: all });
    p.setFileText('/plc/FC_New.s7dcl', fc('FC_New', [], [';']));
    expect(analyzeProject(p).stats).toMatchObject({ full: true, boundBlocks: all + 1 });
    p.removeFile('/plc/FC_New.s7dcl');
    expect(analyzeProject(p).stats).toMatchObject({ full: true, boundBlocks: all });
  });

  it('after any sequence of edits, equals a fresh analysis of the same texts', () => {
    const p = project();
    const steps: [string, () => void][] = [
      ['body edit', () => p.setFileText('/plc/FC_Scale.s7dcl', scale([], '#Out := #In * 3;'))],
      [
        'an error in a body',
        () => p.setFileText('/plc/FC_Scale.s7dcl', scale([], '#Out := #Missing;')),
      ],
      [
        'interface edit',
        () => p.setFileText('/plc/FC_Scale.s7dcl', scale(['        Gain : Int;'])),
      ],
      [
        'unknown member, then declared',
        () =>
          p.setFileText(
            '/plc/FB_Other.s7dcl',
            fb(
              'FB_Other',
              ['    VAR_OUTPUT', '        Copy : Int;', '    END_VAR'],
              ['#Copy := "DB_Data".Total;'],
            ),
          ),
      ],
      [
        'member added',
        () => p.setFileText('/plc/DB_Data.s7dcl', dataBlock(['        Total : Int;'])),
      ],
      ['type edit', () => p.setFileText('/plc/UDT_Motor.s7dcl', udt(['        Fault : Bool;']))],
      ['tag table edit', () => p.setFileText('/plc/Tags.xml', tags('%I0.1'))],
      ['a static read from outside', () => p.setFileText('/plc/FB_Other.s7dcl', readsSpare())],
      [
        'rename',
        () =>
          p.setFileText(
            '/plc/FC_Tags.s7dcl',
            fc(
              'FC_Buttons',
              ['    VAR_OUTPUT', '        Pressed : Bool;', '    END_VAR'],
              ['#Pressed := "StartButton";'],
            ),
          ),
      ],
      ['delete file', () => p.removeFile('/plc/FB_Other.s7dcl')],
      ['add file', () => p.setFileText('/plc/FC_New.s7dcl', fc('FC_New', [], ['"FC_Missing"();']))],
      [
        'the missing block appears',
        () => p.setFileText('/plc/FC_Missing.s7dcl', fc('FC_Missing', [], [';'])),
      ],
      [
        'manifest change',
        () =>
          p.setManifest(
            '/plc/plc.json',
            JSON.stringify({ ...MANIFEST, compiler: { iecCheck: true } }),
          ),
      ],
      [
        'rules change',
        () =>
          p.setRules(
            '/plc/plcstudio.rules.json',
            JSON.stringify({ rules: { 'unused-temp': 'off' } }),
          ),
      ],
      [
        'body edit after settings',
        () => p.setFileText('/plc/FC_Scale.s7dcl', scale(['        Gain : Int;'], ';')),
      ],
    ];
    analyzeProject(p);
    for (const [name, step] of steps) {
      step();
      expect(snapshot(p), name).toEqual(snapshot(fresh(p)));
    }
  });
});
