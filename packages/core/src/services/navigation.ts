// Navigation over the analysis: the reference under the cursor, definitions, references and
// rename across files and units (spec, "Editor features").
import type { Project } from '../model/project.ts';
import { basename, dirname, extname, joinPath, stem } from '../model/paths.ts';
import { analyzeProject } from '../check/analysis.ts';
import type { Reference } from '../check/binder.ts';
import type { TextEdit } from '../writer/text-edit.ts';

/** The reference whose range contains the offset (the innermost one). */
export function referenceAt(project: Project, file: string, offset: number): Reference | undefined {
  const analysis = analyzeProject(project);
  let best: Reference | undefined;
  for (const r of analysis.references) {
    if (r.file !== file || offset < r.range.start || offset > r.range.end) continue;
    if (!best || r.range.end - r.range.start < best.range.end - best.range.start) best = r;
  }
  return best;
}

export function referencesOf(project: Project, symbolId: string): readonly Reference[] {
  return analyzeProject(project).referencesBySymbol.get(symbolId) ?? [];
}

/** Where a symbol is declared. */
export function definitionOf(project: Project, symbolId: string): Reference | undefined {
  return referencesOf(project, symbolId).find((r) => r.access === 'declaration');
}

export interface RenameResult {
  readonly edits: ReadonlyMap<string, readonly TextEdit[]>;
  /** Files to rename together with a block (TIA names files after the object). */
  readonly fileRenames: readonly { readonly from: string; readonly to: string }[];
}

export function validateIdentifier(name: string): string | undefined {
  if (name.length === 0) return 'A name cannot be empty.';
  if (name.length > 128) return 'A name can have at most 128 characters.';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    return 'Use letters, digits and underscores only, starting with a letter or underscore.';
  return undefined;
}

/** Edits for renaming a symbol everywhere it is used; each reference keeps its quoting style. */
export function renameEdits(
  project: Project,
  symbolId: string,
  newName: string,
): RenameResult | { error: string } {
  const problem = validateIdentifier(newName);
  if (problem) return { error: problem };
  const refs = referencesOf(project, symbolId);
  if (refs.length === 0) return { error: 'Nothing to rename here.' };
  const decl = refs.find((r) => r.access === 'declaration');
  const conflict = decl ? nameConflict(project, symbolId, newName) : undefined;
  if (conflict) return { error: conflict };
  const edits = new Map<string, TextEdit[]>();
  for (const r of refs) {
    const file = project.files.get(r.file);
    if (!file) continue;
    const old = file.source.text.slice(r.range.start, r.range.end);
    const text = old.startsWith('"') && old.endsWith('"') ? `"${newName}"` : newName;
    const list = edits.get(r.file) ?? [];
    if (!list.some((e) => e.start === r.range.start))
      list.push({ start: r.range.start, end: r.range.end, newText: text });
    edits.set(r.file, list);
  }
  const fileRenames: { from: string; to: string }[] = [];
  if (symbolId.startsWith('block:') && decl) {
    const base = stem(decl.file);
    const oldName = project.index.block(symbolId)?.name;
    if (oldName && base.toLowerCase() === oldName.toLowerCase()) {
      for (const p of project.files.keys()) {
        if (dirname(p) === dirname(decl.file) && stem(p).toLowerCase() === base.toLowerCase()) {
          fileRenames.push({ from: p, to: joinPath(dirname(p), newName + extname(p)) });
        }
      }
    }
  }
  return { edits, fileRenames };
}

function nameConflict(project: Project, symbolId: string, newName: string): string | undefined {
  const index = project.index;
  if (symbolId.startsWith('block:')) {
    const block = index.block(symbolId);
    const clash = index.blocksNamed(block?.namespace, newName).find((b) => b.id !== symbolId);
    if (clash) return `A block named ${newName} already exists (${basename(clash.file.path)}).`;
    return undefined;
  }
  if (symbolId.startsWith('tag:') || symbolId.startsWith('constant:')) {
    const clash = index.findTag(newName);
    if (clash && clash.id !== symbolId) return `A tag or constant named ${newName} already exists.`;
    return undefined;
  }
  if (symbolId.startsWith('member:')) {
    const parent = symbolId.slice(0, symbolId.lastIndexOf('/'));
    const sibling = `${parent}/${newName.toLowerCase()}`;
    if (
      sibling !== symbolId &&
      analyzeProject(project)
        .referencesBySymbol.get(sibling)
        ?.some((r) => r.access === 'declaration')
    ) {
      return `${newName} is already declared next to this member.`;
    }
  }
  return undefined;
}
