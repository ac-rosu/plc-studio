// Performance gates (spec, "Release gates"): a 5,000-block PLC indexed in under 10 s, and
// diagnostics within 200 ms of typing. Limits carry a margin for slower CI machines; the measured
// times are printed.
import { analyzeProject, Project } from '@plcstudio/core';
import { describe, expect, it } from 'vitest';
import { syntheticPlc } from './synthetic.ts';

describe('performance', () => {
  it('indexes and checks a 5,000-block PLC in under 10 s and re-checks an edit quickly', () => {
    const files = syntheticPlc(5000);
    const blocks = files.filter((f) => f.name.endsWith('.s7dcl')).length;
    expect(blocks).toBeGreaterThan(4800);
    const start = performance.now();
    const project = new Project('/synthetic');
    const manifest = files.find((f) => f.name === 'plc.json')!.text;
    for (const f of files) {
      if (f.name === 'plc.json') project.setManifest('/synthetic/plc.json', f.text);
      else project.setFileText(`/synthetic/${f.name}`, f.text);
    }
    const analysis = analyzeProject(project);
    const indexMs = performance.now() - start;
    const errors = [...analysis.diagnostics.values()].flat().filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);

    // a full re-check without parsing (the manifest was set again): every block bound
    const fullStart = performance.now();
    project.setManifest('/synthetic/plc.json', manifest);
    const full = analyzeProject(project);
    const fullMs = performance.now() - fullStart;
    expect(full.stats.full).toBe(true);

    // one body edit: only that block is bound again (M2.9, M6.8)
    const target = files.find((f) => f.name === 'FB_Unit7.s7dcl')!;
    const editStart = performance.now();
    project.setFileText(
      '/synthetic/FB_Unit7.s7dcl',
      target.text.replace('#State := 1;', '#State := #Missing;'),
    );
    const after = analyzeProject(project);
    const editMs = performance.now() - editStart;
    expect(
      after.diagnostics
        .get('/synthetic/FB_Unit7.s7dcl')
        ?.some((d) => d.code === 'undeclared-local'),
    ).toBe(true);
    expect(after.stats).toMatchObject({ full: false, extractedFiles: 1, boundBlocks: 1 });

    console.log(
      `performance: ${blocks} blocks indexed and checked in ${Math.round(indexMs)} ms; full re-check ${Math.round(fullMs)} ms; one edit re-checked in ${Math.round(editMs)} ms (${after.stats.boundBlocks} block bound, ${after.stats.analyzedBlocks} analyzed)`,
    );
    expect(indexMs).toBeLessThan(10_000);
    expect(editMs).toBeLessThan(1_000);
    expect(editMs).toBeLessThan(fullMs / 2);
  });
});
