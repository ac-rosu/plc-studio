// Incremental analysis on the corpus PLC (M2.9, M6.8): after scripted edits, the incremental
// result equals a fresh analysis of the same texts, and a body edit binds only its own file.
import { analyzeProject, Project } from '@plcstudio/core';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assemblePlcs, loadCases } from './corpus.ts';
import { corpusProject } from './core-adapters.ts';

const corpusRoot = fileURLToPath(new URL('../../../corpus', import.meta.url));
const plc = assemblePlcs(loadCases(corpusRoot, 'V21'), 'documents').find(
  (p) => p.name === 'PLC_Main',
)!;

function snapshot(p: Project) {
  const a = analyzeProject(p);
  return {
    diagnostics: [...a.diagnostics]
      .map(([file, list]) => [
        file,
        list.map((d) => [d.range.start, d.range.end, d.severity, d.code, d.message]),
      ])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    references: [...a.referencesBySymbol]
      .map(([id, list]) => [id, list.map((r) => [r.file, r.range.start, r.access, r.blockId])])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    calls: a.calls.map((c) => [c.callerId, c.file, c.range.start, c.calleeId, c.kind]),
  };
}

/** The same files in the same order, analysed from scratch. */
function fresh(p: Project): Project {
  const q = new Project(p.root);
  if (p.manifestPath && p.manifestText !== undefined) q.setManifest(p.manifestPath, p.manifestText);
  for (const f of p.files.values()) q.setFile(f.path, f.source);
  return q;
}

function pathOf(p: Project, name: string): string {
  const path = [...p.files.keys()].find((k) => k.endsWith('/' + name));
  if (!path) throw new Error(`${name} is not in the corpus PLC`);
  return path;
}

/** Replaces text in a file, keeping its line ending for inserted lines (`\n` in `to`). */
function edit(p: Project, name: string, from: string, to: string): void {
  const path = pathOf(p, name);
  const text = p.files.get(path)!.source.text;
  expect(text.includes(from), `${name} contains ${from}`).toBe(true);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  p.setFileText(path, text.replace(from, to.replace(/\n/g, eol)));
}

describe('incremental analysis on the corpus PLC', () => {
  it('equals a fresh analysis after every scripted edit', () => {
    const { project } = corpusProject(plc, corpusRoot);
    const first = analyzeProject(project);
    expect(first.stats.full).toBe(true);
    const all = first.blocks.size;

    // a body edit binds only the blocks of its file
    edit(project, 'FC_SclTypes.s7dcl', '#TempByte := 16#0F;', '#TempByte := 16#1F;');
    expect(analyzeProject(project).stats).toMatchObject({
      full: false,
      boundBlocks: 1,
      reusedBlocks: all - 1,
    });
    expect(snapshot(project)).toEqual(snapshot(fresh(project)));

    const steps: [string, () => void][] = [
      [
        'an error in a body',
        () => edit(project, 'FC_SclTypes.s7dcl', '#TempBool := TRUE;', '#TempBool := #Nope;'),
      ],
      [
        'an interface edit',
        () =>
          edit(
            project,
            'FC_SclTypes.s7dcl',
            'InInt : Int;',
            'InInt : Int;\n        InExtra : Int;',
          ),
      ],
      [
        'a type edit',
        () =>
          edit(
            project,
            'UDT_Motor.s7dcl',
            'StartCount : DInt := 0;',
            'StartCount : DInt := 0;\n        Spare : Int;',
          ),
      ],
      ['a tag table edit', () => edit(project, 'Tags_IO.xml', '%I0.1', '%I0.7')],
      ['a file removed', () => project.removeFile(pathOf(project, 'UDT_Line.s7dcl'))],
    ];
    for (const [name, step] of steps) {
      step();
      expect(snapshot(project), name).toEqual(snapshot(fresh(project)));
    }
  });
});
