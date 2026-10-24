// Project-wide analysis: syntax, binding and checker diagnostics, references and call sites of
// every block, cached per project revision. Binding is incremental (M2.9, M6.8): a block is bound
// again only when its file changed or when a declaration it depends on changed; every other
// block keeps the result of the last revision.
import type { SyntaxDiagnostic, TypeNode } from '../syntax/ast.ts';
import type {
  BlockSymbol,
  FileSymbols,
  LocatedDiagnostic,
  Project,
  ProjectFile,
} from '../model/project.ts';
import { BlockBinder, type BlockAnalysis, type CallSite, type Reference } from './binder.ts';

/** What the last analysis recomputed, for tests and timing. */
export interface AnalysisStats {
  /** Files whose symbols were extracted again; the others came from the last index. */
  readonly extractedFiles: number;
  /** Blocks bound in this revision. */
  readonly boundBlocks: number;
  /** Blocks whose binding was taken over from the last revision. */
  readonly reusedBlocks: number;
  /** Every block was bound: first run, manifest or rules changed, or the set of names changed. */
  readonly full: boolean;
  /** Blocks whose single-block analyzer rules ran (filled in by the analyzer pass). */
  analyzedBlocks: number;
}

/** What changed since the last revision, for passes that cache per block. */
export interface AnalysisChanges {
  /** Everything was bound again; per-block caches must not be used. */
  readonly full: boolean;
  /**
   * Owners (block, tag or constant ids) of everything the blocks bound in this revision
   * reference now or referenced before: results that read references of these may differ.
   */
  readonly touchedOwners: ReadonlySet<string>;
}

export interface ProjectAnalysis {
  readonly revision: number;
  readonly blocks: ReadonlyMap<string, BlockAnalysis>;
  readonly references: readonly Reference[];
  readonly referencesBySymbol: ReadonlyMap<string, readonly Reference[]>;
  readonly calls: readonly CallSite[];
  /** Every diagnostic, by file path. */
  readonly diagnostics: ReadonlyMap<string, readonly SyntaxDiagnostic[]>;
  readonly stats: AnalysisStats;
  readonly changes: AnalysisChanges;
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

// --- Incremental binding -------------------------------------------------------------------------

/**
 * The block, tag or constant a symbol id belongs to: `member:ns.fb/a/b` → `block:ns.fb`,
 * `member:tag:t/x` → `tag:t`; block, tag and other ids are their own owner.
 */
export function ownerOf(id: string): string {
  if (!id.startsWith('member:')) return id;
  const head = id.slice('member:'.length).split('/')[0]!;
  return head.includes(':') ? head : 'block:' + head;
}

interface BlockEntry {
  readonly file: ProjectFile;
  readonly analysis: BlockAnalysis;
  /** Owners of everything the block references or calls. */
  readonly owners: ReadonlySet<string>;
}

interface FileState {
  readonly file: ProjectFile;
  /** Everything other blocks can depend on: declarations and flags, not code. */
  readonly signature: string;
  readonly ownerIds: readonly string[];
  /** Lowercase names of the blocks it declares (for the declaration closure). */
  readonly blockNames: readonly string[];
  /** Tag tables: the text of each tag or constant, by lowercase name. */
  readonly tagTexts: ReadonlyMap<string, string> | undefined;
}

interface IncrementalState {
  readonly settings: number;
  readonly names: string;
  readonly files: ReadonlyMap<string, FileState>;
  readonly entries: ReadonlyMap<string, BlockEntry>;
}

const states = new WeakMap<Project, IncrementalState>();
const fileStates = new WeakMap<FileSymbols, FileState>();
const declaredTypes = new WeakMap<BlockSymbol, readonly string[]>();

const entryKey = (symbol: BlockSymbol) => `${symbol.file.path}\n${symbol.id}`;

function fileState(f: FileSymbols): FileState {
  let state = fileStates.get(f);
  if (state) return state;
  const text = f.file.source.text;
  let signature: string;
  let tagTexts: Map<string, string> | undefined;
  if (f.file.parsed?.kind === 'blocks') {
    // the file without the code part of each block, plus the flags other blocks read
    const parts: string[] = [];
    let at = 0;
    for (const s of f.blocks) {
      const b = s.block;
      parts.push(
        `${s.id}|${s.kind}|${s.dbKind}|${s.incomplete}|${s.failsafe}|${s.published}|${s.iecCheck}|${s.optimized}\n`,
        text.slice(at, Math.max(at, b.codeStart)),
      );
      at = Math.max(at, b.range.end);
    }
    parts.push(text.slice(at));
    signature = 'blocks\n' + parts.join('');
  } else if (f.file.parsed?.kind === 'tagTable') {
    signature = 'tags\n' + text;
    tagTexts = new Map(
      f.tags.map((t) => [t.name.toLowerCase(), text.slice(t.entry.range.start, t.entry.range.end)]),
    );
  } else {
    // .s7res, OB SimaticML and other files are not read by the binder
    signature = f.file.parsed?.kind ?? 'other';
  }
  state = {
    file: f.file,
    signature,
    ownerIds: [...f.blocks.map((b) => b.id), ...f.tags.map((t) => t.id)],
    blockNames: f.blocks.map((b) => b.name.toLowerCase()),
    tagTexts,
  };
  fileStates.set(f, state);
  return state;
}

/** Lowercase names of the types a block's declarations use (UDTs, FBs, instance DB types). */
function typesDeclaredBy(symbol: BlockSymbol): readonly string[] {
  let names = declaredTypes.get(symbol);
  if (names) return names;
  const out = new Set<string>();
  const visit = (t: TypeNode | undefined): void => {
    if (!t) return;
    switch (t.kind) {
      case 'named': {
        const last = t.path[t.path.length - 1];
        if (last) out.add(last.text.toLowerCase());
        break;
      }
      case 'array':
        visit(t.element);
        break;
      case 'ref':
        visit(t.target);
        break;
      case 'struct':
        for (const m of t.members) visit(m.type);
        break;
      default:
        break;
    }
  };
  const b = symbol.block;
  for (const s of b.sections) for (const m of s.members) visit(m.type);
  for (const m of b.struct?.members ?? []) visit(m.type);
  visit(b.dbType);
  visit(b.returnType);
  names = [...out];
  declaredTypes.set(symbol, names);
  return names;
}

function ownersOf(analysis: BlockAnalysis): Set<string> {
  const owners = new Set<string>();
  for (const r of analysis.references) owners.add(ownerOf(r.symbolId));
  for (const c of analysis.calls) {
    if (c.calleeId) owners.add(ownerOf(c.calleeId));
    if (c.instance) owners.add(ownerOf(c.instance.id));
  }
  return owners;
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) return true;
  return false;
};

/**
 * Which blocks must be bound again (undefined: all of them). The rule, conservative on purpose:
 * - first run, manifest or rules changed, or a block, tag or constant appeared or disappeared
 *   (names resolve differently): every block;
 * - a file changed only in code parts: the blocks of that file;
 * - a file's declarations or flags changed (or the file came or went): the blocks of that file,
 *   every block whose declarations use one of its blocks as a type (repeated), every block that
 *   references one of those, and, for a tag table, every block file that mentions a changed tag.
 */
function blocksToBind(
  prev: IncrementalState | undefined,
  settings: number,
  names: string,
  files: ReadonlyMap<string, FileState>,
  symbols: readonly BlockSymbol[],
  tagsOfIndex: readonly { id: string; name: string; entry: { dataType: string } }[],
): { keys: Set<string>; tagTablesChanged: boolean } | undefined {
  if (!prev || prev.settings !== settings || prev.names !== names) return undefined;
  let tagTablesChanged = false;
  const changedFiles = new Set<string>();
  const affected = new Set<string>();
  const seedNames: string[] = [];
  const changedTags: string[] = [];
  const declChanged = (state: FileState) => {
    for (const id of state.ownerIds) affected.add(id);
    seedNames.push(...state.blockNames);
  };
  for (const [path, state] of files) {
    const old = prev.files.get(path);
    if (old?.file === state.file) continue;
    changedFiles.add(path);
    if (state.tagTexts || old?.tagTexts) tagTablesChanged = true;
    if (old?.signature === state.signature) continue;
    declChanged(state);
    if (old) declChanged(old);
    if (state.tagTexts || old?.tagTexts) {
      const before = old?.tagTexts ?? new Map<string, string>();
      const after = state.tagTexts ?? new Map<string, string>();
      for (const [name, text] of after) if (before.get(name) !== text) changedTags.push(name);
      for (const name of before.keys()) if (!after.has(name)) changedTags.push(name);
    }
  }
  for (const [path, old] of prev.files) {
    if (files.has(path)) continue;
    changedFiles.add(path);
    if (old.tagTexts) tagTablesChanged = true;
    declChanged(old);
  }
  if (changedFiles.size === 0) return { keys: new Set(), tagTablesChanged };
  // declarations that use a changed block as a type change with it
  const users = new Map<string, BlockSymbol[]>();
  for (const s of symbols)
    for (const n of typesDeclaredBy(s)) {
      const list = users.get(n);
      if (list) list.push(s);
      else users.set(n, [s]);
    }
  const typedTags = new Map<string, string[]>();
  for (const t of tagsOfIndex) {
    const n = t.entry.dataType.replace(/^"|"$/g, '').toLowerCase();
    const list = typedTags.get(n);
    if (list) list.push(t.id);
    else typedTags.set(n, [t.id]);
  }
  const seen = new Set<string>();
  while (seedNames.length > 0) {
    const n = seedNames.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const id of typedTags.get(n) ?? []) affected.add(id);
    for (const s of users.get(n) ?? []) {
      affected.add(s.id);
      seedNames.push(s.name.toLowerCase());
    }
  }
  const mentions = changedTags.length > 0 ? changedTags : undefined;
  const filesMentioning = new Set<string>();
  if (mentions)
    for (const [path, state] of files) {
      const lower = state.signature.toLowerCase();
      if (mentions.some((n) => lower.includes(n))) filesMentioning.add(path);
    }
  const keys = new Set<string>();
  for (const s of symbols) {
    const key = entryKey(s);
    const entry = prev.entries.get(key);
    if (
      !entry ||
      entry.file !== s.file ||
      changedFiles.has(s.file.path) ||
      filesMentioning.has(s.file.path) ||
      affected.has(s.id) ||
      intersects(entry.owners, affected)
    )
      keys.add(key);
  }
  return { keys, tagTablesChanged };
}

/** Where a reference stands in a fresh build: tag declarations first, then in block order. */
function rankIn(order: ReadonlyMap<string, number>) {
  return (r: Reference) => (r.blockId === '' ? -1 : (order.get(r.blockId) ?? order.size));
}

/**
 * References by symbol, updated from the last revision when only some blocks were bound again:
 * the lists of the symbols those blocks referenced before or reference now are rebuilt, in the
 * order a fresh build gives; every other list is shared with the last revision.
 */
function updateReferencesBySymbol(
  previous: ReadonlyMap<string, readonly Reference[]>,
  blocks: ReadonlyMap<string, BlockAnalysis>,
  rebound: ReadonlySet<string>,
  stale: readonly (readonly Reference[])[],
  fresh: readonly (readonly Reference[])[],
): Map<string, readonly Reference[]> {
  const map = new Map(previous);
  const added = new Map<string, Reference[]>();
  for (const list of fresh)
    for (const r of list) {
      const l = added.get(r.symbolId);
      if (l) l.push(r);
      else added.set(r.symbolId, [r]);
    }
  const ids = new Set(added.keys());
  for (const list of stale) for (const r of list) ids.add(r.symbolId);
  const order = new Map<string, number>();
  for (const id of blocks.keys()) order.set(id, order.size);
  const rank = rankIn(order);
  for (const id of ids) {
    const merged = [
      ...(previous.get(id) ?? []).filter((r) => !rebound.has(r.blockId)),
      ...(added.get(id) ?? []),
    ];
    merged.sort((a, b) => rank(a) - rank(b));
    if (merged.length > 0) map.set(id, merged);
    else map.delete(id);
  }
  return map;
}

export function analyzeProject(project: Project): ProjectAnalysis {
  const cached = cache.get(project);
  if (cached && cached.revision === project.revision) return cached;
  const index = project.index;
  const prev = states.get(project);
  const files = new Map<string, FileState>();
  for (const f of index.fileSymbols) files.set(f.file.path, fileState(f));
  const names = [
    ...index.blocks.map((b) => `b|${(b.namespace ?? '').toLowerCase()}|${b.name.toLowerCase()}`),
    ...index.tags.map((t) => `t|${t.id}`),
  ]
    .sort()
    .join('\n');
  const plan = blocksToBind(prev, project.settingsRevision, names, files, index.blocks, index.tags);
  const rebind = plan?.keys;
  const previousAnalysis = cached;
  const reboundIds = new Set<string>();
  const stale: (readonly Reference[])[] = [];
  const fresh: (readonly Reference[])[] = [];
  const blocks = new Map<string, BlockAnalysis>();
  const entries = new Map<string, BlockEntry>();
  const touched = new Set<string>();
  const located: LocatedDiagnostic[] = [...index.diagnostics];
  const semantic = project.hasManifest;
  let bound = 0;
  let reused = 0;
  for (const symbol of index.blocks) {
    if (blocks.has(symbol.id) && blocks.get(symbol.id)!.symbol.file.path !== symbol.file.path)
      continue;
    const key = entryKey(symbol);
    const old = prev?.entries.get(key);
    let entry: BlockEntry;
    if (!rebind || rebind.has(key) || !old || old.file !== symbol.file) {
      const analysis = new BlockBinder(index, symbol).run();
      entry = { file: symbol.file, analysis, owners: ownersOf(analysis) };
      bound++;
      if (rebind) {
        for (const o of entry.owners) touched.add(o);
        for (const o of old?.owners ?? []) touched.add(o);
        touched.add(symbol.id);
        reboundIds.add(symbol.id);
        fresh.push(analysis.references);
        if (old) stale.push(old.analysis.references);
      }
    } else {
      // the binding holds plain data; only the symbol object is the new index's
      entry = { ...old, analysis: { ...old.analysis, symbol } };
      reused++;
    }
    entries.set(key, entry);
    blocks.set(symbol.id, entry.analysis);
    if (semantic) located.push(...entry.analysis.diagnostics);
  }
  if (rebind && prev)
    for (const [key, old] of prev.entries) {
      if (entries.has(key)) continue;
      for (const o of old.owners) touched.add(o);
      touched.add(old.analysis.symbol.id);
      reboundIds.add(old.analysis.symbol.id);
      stale.push(old.analysis.references);
    }
  states.set(project, {
    settings: project.settingsRevision,
    names,
    files,
    entries,
  });

  let referencesBySymbol: ReadonlyMap<string, readonly Reference[]>;
  if (rebind && plan && !plan.tagTablesChanged && previousAnalysis) {
    referencesBySymbol = updateReferencesBySymbol(
      previousAnalysis.referencesBySymbol,
      blocks,
      reboundIds,
      stale,
      fresh,
    );
  } else {
    const bySymbol = new Map<string, Reference[]>();
    for (const b of blocks.values())
      for (const r of b.references) {
        const list = bySymbol.get(r.symbolId);
        if (list) list.push(r);
        else bySymbol.set(r.symbolId, [r]);
      }
    for (const tag of index.tags)
      bySymbol.set(tag.id, [tagDeclaration(tag), ...(bySymbol.get(tag.id) ?? [])]);
    referencesBySymbol = bySymbol;
  }
  // every reference in one list, made when first asked for: block order, then tag declarations
  let references: Reference[] | undefined;
  const allReferences = () => {
    if (!references) {
      references = [...blocks.values()].flatMap((b) => b.references);
      for (const tag of index.tags) references.push(tagDeclaration(tag));
    }
    return references;
  };
  let calls: CallSite[] | undefined;
  const allCalls = () => (calls ??= [...blocks.values()].flatMap((b) => b.calls));
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
    get references() {
      return allReferences();
    },
    referencesBySymbol,
    get calls() {
      return allCalls();
    },
    diagnostics,
    stats: {
      extractedFiles: index.extractedFiles,
      boundBlocks: bound,
      reusedBlocks: reused,
      full: rebind === undefined,
      analyzedBlocks: 0,
    },
    changes: { full: rebind === undefined, touchedOwners: touched },
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

function tagDeclaration(tag: {
  id: string;
  kind: 'tag' | 'constant' | 'systemConstant';
  file: ProjectFile;
  entry: { nameRange: Reference['range'] };
}): Reference {
  return {
    file: tag.file.path,
    range: tag.entry.nameRange,
    symbolId: tag.id,
    symbolKind: tag.kind === 'tag' ? 'tag' : 'constant',
    access: 'declaration',
    blockId: '',
  };
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
