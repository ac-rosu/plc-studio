// Project-wide analysis: syntax, binding and checker diagnostics, references and call sites of
// every block, cached per project revision.
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

export type DiagnosticFilter = (
  project: Project,
  analysis: ProjectAnalysis,
  diagnostics: LocatedDiagnostic[],
) => LocatedDiagnostic[];

const filters: DiagnosticFilter[] = [];

/** Registers a filter over the semantic diagnostics (configured severities, suppressions). */
export function registerFilter(filter: DiagnosticFilter): void {
  filters.push(filter);
}

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
  if (project.rulesPath) for (const d of project.rulesDiagnostics) add(project.rulesPath, d);
  let filtered = located;
  if (semantic) for (const filter of filters) filtered = filter(project, analysis, filtered);
  for (const d of filtered) {
    const { file, ...rest } = d;
    add(file, rest);
  }
  cache.set(project, analysis);
  return analysis;
}

/**
 * Texts missing in a language (spec: info). The languages are the manifest's `languages`; without
 * them, those of the same .s7res file, so a single translated block does not flag every
 * untranslated text of the PLC.
 */
function missingTranslations(project: Project): LocatedDiagnostic[] {
  const declared = project.manifest?.languages ?? [];
  const out: LocatedDiagnostic[] = [];
  for (const f of project.files.values()) {
    if (f.parsed?.kind !== 'resources') continue;
    const path = f.path;
    const res = f.parsed;
    const cultures = new Set<string>(declared);
    if (declared.length === 0)
      for (const e of res.entries) for (const v of e.values) cultures.add(v.culture);
    if (cultures.size < 2) continue;
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
