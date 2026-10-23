// Project-wide analysis: syntax, binding and checker diagnostics, references and call sites of
// every block, cached per project revision.
import type { ResourceFile } from '../formats/s7res.ts';
import type { SyntaxDiagnostic } from '../syntax/ast.ts';
import type { BlockSymbol, LocatedDiagnostic, Project } from '../model/project.ts';
import { BlockBinder, type BlockAnalysis, type CallSite, type Reference } from './binder.ts';

export interface ProjectAnalysis {
  readonly revision: number;
  readonly blocks: ReadonlyMap<string, BlockAnalysis>;
  readonly references: readonly Reference[];
  readonly referencesBySymbol: ReadonlyMap<string, readonly Reference[]>;
  readonly calls: readonly CallSite[];
  /** Every diagnostic, by file path. */
  readonly diagnostics: ReadonlyMap<string, readonly SyntaxDiagnostic[]>;
  /** Hook for later passes (analyzer, call graph) to add diagnostics. */
}

const cache = new WeakMap<Project, ProjectAnalysis>();

export type AnalysisPass = (project: Project, analysis: ProjectAnalysis) => LocatedDiagnostic[];

const passes: AnalysisPass[] = [];

/** Registers a pass that runs after binding (analyzer rules, cross-block rules). */
export function registerPass(pass: AnalysisPass): void {
  passes.push(pass);
}

export function analyzeProject(project: Project): ProjectAnalysis {
  const cached = cache.get(project);
  if (cached && cached.revision === project.revision) return cached;
  const index = project.index;
  const blocks = new Map<string, BlockAnalysis>();
  const located: LocatedDiagnostic[] = [...index.diagnostics];
  const semantic = project.hasManifest;
  for (const symbol of index.blocks) {
    if (blocks.has(symbol.id) && blocks.get(symbol.id)!.symbol.file.path !== symbol.file.path)
      continue;
    const analysis = new BlockBinder(index, symbol).run();
    blocks.set(symbol.id, analysis);
    if (semantic) located.push(...analysis.diagnostics);
  }
  const references = [...blocks.values()].flatMap((b) => b.references);
  const referencesBySymbol = new Map<string, Reference[]>();
  for (const r of references) {
    const list = referencesBySymbol.get(r.symbolId);
    if (list) list.push(r);
    else referencesBySymbol.set(r.symbolId, [r]);
  }
  for (const tag of index.tags) {
    const decl: Reference = {
      file: tag.file.path,
      range: tag.entry.nameRange,
      symbolId: tag.id,
      symbolKind: tag.kind === 'tag' ? 'tag' : 'constant',
      access: 'declaration',
      blockId: '',
    };
    referencesBySymbol.set(tag.id, [decl, ...(referencesBySymbol.get(tag.id) ?? [])]);
    references.push(decl);
  }
  const calls = [...blocks.values()].flatMap((b) => b.calls);
  const diagnostics = new Map<string, SyntaxDiagnostic[]>();
  const add = (file: string, d: SyntaxDiagnostic) => {
    const list = diagnostics.get(file);
    if (list) list.push(d);
    else diagnostics.set(file, [d]);
  };
  for (const file of project.files.values()) {
    for (const d of file.parsed?.diagnostics ?? []) add(file.path, d);
  }
  if (project.manifestPath)
    for (const d of project.manifestDiagnostics) add(project.manifestPath, d);
  if (semantic) located.push(...missingTranslations(project));
  const analysis: ProjectAnalysis = {
    revision: project.revision,
    blocks,
    references,
    referencesBySymbol,
    calls,
    diagnostics,
  };
  if (semantic) for (const pass of passes) located.push(...pass(project, analysis));
  for (const d of located) {
    const { file, ...rest } = d;
    add(file, rest);
  }
  cache.set(project, analysis);
  return analysis;
}

/** Texts that exist in some languages of the project but not in all (spec: info). */
function missingTranslations(project: Project): LocatedDiagnostic[] {
  const resources: { path: string; res: ResourceFile }[] = [];
  for (const f of project.files.values())
    if (f.parsed?.kind === 'resources') resources.push({ path: f.path, res: f.parsed });
  const cultures = new Set<string>();
  for (const { res } of resources)
    for (const e of res.entries) for (const v of e.values) cultures.add(v.culture);
  if (cultures.size < 2) return [];
  const out: LocatedDiagnostic[] = [];
  for (const { path, res } of resources) {
    for (const e of res.entries) {
      const have = new Set(e.values.map((v) => v.culture));
      const missing = [...cultures].filter((c) => !have.has(c)).sort();
      if (missing.length > 0 && have.size > 0) {
        out.push({
          file: path,
          range: e.idRange,
          severity: 'info',
          code: 'missing-translation',
          message: `Text ${e.id} has no ${missing.join(', ')} translation.`,
        });
      }
    }
  }
  return out;
}

export function blockAnalysis(project: Project, symbol: BlockSymbol): BlockAnalysis | undefined {
  return analyzeProject(project).blocks.get(symbol.id);
}
