// Rules between the safety program and the standard program (spec, "Fail-safe blocks"), each
// proven in TIA V21: no calls across the boundary (B43, B44), standard blocks may read F-DBs
// (C38) but not write them (B42), and inside the safety program a standard operand is either
// read or written, not both (B45, C39). Which F-blocks form the safety program the files do not
// say: the manifest's mainSafetyBlocks decide; without them the last rule only warns.
import type { BlockSymbol, LocatedDiagnostic, Project } from '../model/project.ts';
import { ownerOf, registerPass, type ProjectAnalysis } from './analysis.ts';
import type { Reference } from './binder.ts';

const isCode = (b: BlockSymbol | undefined) => b?.kind === 'FB' || b?.kind === 'FC';

/** The whole operand a member reference ends: "DB_Machine".MachineOn, not only MachineOn. */
function operandText(project: Project, r: Reference): string {
  const text = project.files.get(r.file)?.source.text ?? '';
  let start = r.range.start;
  while (start > 0 && /[\w."#[\]]/.test(text[start - 1]!)) start--;
  return text.slice(start, r.range.end);
}

/** References whose symbol a later segment of the same path refines ("DB".S in "DB".S.X). */
function refined(refs: readonly Reference[], r: Reference): boolean {
  return refs.some(
    (o) =>
      o !== r &&
      o.symbolId.startsWith(r.symbolId + '/') &&
      o.range.start >= r.range.end &&
      o.range.start - r.range.end <= 2,
  );
}

export function failsafeDiagnostics(
  project: Project,
  analysis: ProjectAnalysis,
): LocatedDiagnostic[] {
  const index = project.index;
  const out: LocatedDiagnostic[] = [];

  // calls across the boundary, in either direction
  for (const call of analysis.calls) {
    if ((call.kind !== 'fb' && call.kind !== 'fc') || !call.calleeId) continue;
    const caller = index.block(call.callerId);
    const callee = index.block(call.calleeId);
    if (!caller || !callee || caller.failsafe === callee.failsafe) continue;
    out.push({
      file: call.file,
      range: call.range,
      severity: 'error',
      code: 'failsafe-call',
      message: caller.failsafe
        ? `A fail-safe block cannot call the standard block ${callee.name}.`
        : `A standard block cannot call the fail-safe block ${callee.name}.`,
    });
  }

  // standard blocks may read F-DBs, never write them
  for (const block of analysis.blocks.values()) {
    if (block.symbol.failsafe) continue;
    const writes = block.references.filter(
      (r) => (r.access === 'write' || r.access === 'readwrite') && r.symbolId.startsWith('member:'),
    );
    for (const r of writes) {
      const owner = index.block(ownerOf(r.symbolId));
      if (owner?.kind !== 'DB' || !owner.failsafe || refined(writes, r)) continue;
      out.push({
        file: r.file,
        range: r.range,
        severity: 'error',
        code: 'failsafe-standard-write',
        message: `A standard block cannot write ${operandText(project, r)}: ${owner.name} is a fail-safe DB.`,
      });
    }
  }

  out.push(...safetyProgramAccess(project, analysis));
  return out;
}

/** The F-blocks reachable from each main safety block, by root. */
function runtimeGroups(
  project: Project,
  analysis: ProjectAnalysis,
): { roots: BlockSymbol[]; declared: boolean; members: Map<BlockSymbol, Set<BlockSymbol>> } {
  const index = project.index;
  const fCode = index.blocks.filter((b) => b.failsafe && isCode(b));
  const callees = new Map<string, Set<string>>();
  const calledByF = new Set<string>();
  for (const call of analysis.calls) {
    if (!call.calleeId) continue;
    const caller = index.block(call.callerId);
    const callee = index.block(call.calleeId);
    if (!caller?.failsafe || !callee?.failsafe || !isCode(callee)) continue;
    let set = callees.get(caller.id);
    if (!set) callees.set(caller.id, (set = new Set()));
    set.add(callee.id);
    calledByF.add(callee.id);
  }
  const names = project.manifest?.mainSafetyBlocks ?? [];
  const declared = names.length > 0;
  const roots = declared
    ? names.flatMap((n) => index.findBlock(n.replace(/^"|"$/g, ''), undefined) ?? [])
    : fCode.filter((b) => !calledByF.has(b.id));
  const members = new Map<BlockSymbol, Set<BlockSymbol>>();
  for (const root of roots) {
    const seen = new Set<BlockSymbol>([root]);
    const queue = [root.id];
    while (queue.length > 0) {
      for (const id of callees.get(queue.shift()!) ?? []) {
        const b = index.block(id);
        if (b && !seen.has(b)) {
          seen.add(b);
          queue.push(id);
        }
      }
    }
    members.set(root, seen);
  }
  return { roots, declared, members };
}

/**
 * Inside one F-runtime group a standard operand (bit memory or a member of a standard DB) is
 * either read or written; TIA reports every access of an operand used both ways. I/O tags are left
 * out, because the files do not say which of them are fail-safe I/O.
 */
function safetyProgramAccess(project: Project, analysis: ProjectAnalysis): LocatedDiagnostic[] {
  const index = project.index;
  const { roots, declared, members } = runtimeGroups(project, analysis);
  const out: LocatedDiagnostic[] = [];
  const reported = new Set<string>();
  const standardOperand = (id: string): boolean => {
    if (id.startsWith('tag:')) {
      const address = index.findTag(id.slice('tag:'.length))?.entry.address ?? '';
      return /^%M/i.test(address);
    }
    if (!id.startsWith('member:')) return false;
    const owner = index.block(ownerOf(id));
    return owner?.kind === 'DB' && !owner.failsafe;
  };
  for (const root of roots) {
    const reads = new Map<string, Reference[]>();
    const writes = new Map<string, Reference[]>();
    for (const b of members.get(root) ?? []) {
      for (const r of analysis.blocks.get(b.id)?.references ?? []) {
        if (!standardOperand(r.symbolId)) continue;
        const add = (map: Map<string, Reference[]>) =>
          map.set(r.symbolId, [...(map.get(r.symbolId) ?? []), r]);
        if (r.access === 'read' || r.access === 'readwrite') add(reads);
        if (r.access === 'write' || r.access === 'readwrite') add(writes);
      }
    }
    const used = [...new Set([...reads.keys(), ...writes.keys()])];
    for (const id of used) {
      if (!reads.has(id) || !writes.has(id)) continue;
      // a struct whose members are accessed separately is not one operand
      if (used.some((other) => other !== id && other.startsWith(id + '/'))) continue;
      for (const [r, kind] of [
        ...reads.get(id)!.map((r) => [r, 'reads'] as const),
        ...writes.get(id)!.map((r) => [r, 'writes'] as const),
      ]) {
        const key = `${r.file}:${r.range.start}:${kind}`;
        if (reported.has(key)) continue;
        reported.add(key);
        const text = r.symbolId.startsWith('member:')
          ? operandText(project, r)
          : project.files.get(r.file)?.source.text.slice(r.range.start, r.range.end);
        out.push({
          file: r.file,
          range: r.range,
          severity: declared ? 'error' : 'warning',
          code: 'failsafe-read-write',
          message:
            `The safety program ${kind === 'reads' ? 'reads' : 'writes'} the standard operand ${text}, ` +
            `which it also ${kind === 'reads' ? 'writes' : 'reads'}; standard data may only be read or only be written there.` +
            (declared
              ? ''
              : ' (Main safety blocks are not listed in plc.json, so this may not apply.)'),
        });
      }
    }
  }
  if (declared) {
    const inProgram = new Set([...members.values()].flatMap((s) => [...s]));
    for (const b of index.blocks) {
      if (!b.failsafe || !isCode(b) || inProgram.has(b)) continue;
      out.push({
        file: b.file.path,
        range: b.block.name.range,
        severity: 'warning',
        code: 'failsafe-unused',
        message: `${b.name} is not called from a main safety block, so it is not part of the safety program.`,
      });
    }
  }
  return out;
}

registerPass(failsafeDiagnostics);
