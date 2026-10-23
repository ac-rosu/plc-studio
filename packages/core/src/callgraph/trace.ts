// Trace value (spec, "Value tracing and views"): every write and read of a variable, tag or DB
// member across the call tree, following parameters into and out of other blocks.
import { analyzeProject } from '../check/analysis.ts';
import type { Access, CallSite } from '../check/binder.ts';
import { AnalyzerContext } from '../analyzer/context.ts';
import { memberId, type Project } from '../model/project.ts';
import type { Range } from '../text/source-text.ts';

export interface TraceEntry {
  readonly symbolId: string;
  readonly file: string;
  readonly range: Range;
  readonly access: Access;
  readonly blockId: string;
  readonly blockName: string;
  /** How the trace got here, outermost first, e.g. "OB_Main → FB_Motor.Speed". */
  readonly via: readonly string[];
}

function ownerBlockId(id: string): string | undefined {
  return id.startsWith('member:') ? 'block:' + id.slice('member:'.length).split('/')[0] : undefined;
}

/** Every use of a symbol (and of its members), plus where parameters carry it into and out of blocks. */
export function traceValue(
  project: Project,
  symbolId: string,
  options: { maxDepth?: number } = {},
): TraceEntry[] {
  const analysis = analyzeProject(project);
  const ctx = new AnalyzerContext(project, analysis);
  const maxDepth = options.maxDepth ?? 8;
  const out: TraceEntry[] = [];
  const seen = new Set<string>();
  const queue: { id: string; via: string[] }[] = [{ id: symbolId, via: [] }];
  const blockName = (id: string) => project.index.block(id)?.name ?? id;
  const argSymbol = (call: CallSite, value: CallSite['args'][number]['value']) =>
    ctx.referenceOf(call.file, value)?.symbolId ?? ctx.rootReference(call.file, value)?.symbolId;
  while (queue.length > 0) {
    const { id, via } = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const [sid, refs] of analysis.referencesBySymbol) {
      if (sid !== id && !sid.startsWith(id + '/')) continue;
      for (const r of refs) {
        if (r.access === 'declaration' || r.access === 'type') continue;
        out.push({
          symbolId: sid,
          file: r.file,
          range: r.range,
          access: r.access,
          blockId: r.blockId,
          blockName: blockName(r.blockId),
          via,
        });
      }
    }
    if (via.length >= maxDepth) continue;
    // into blocks: the symbol is passed to a parameter
    for (const call of analysis.calls) {
      if (!call.calleeId?.startsWith('block:')) continue;
      for (const a of call.args) {
        if (!a.parameter || argSymbol(call, a.value) !== id) continue;
        queue.push({
          id: memberId(call.calleeId, a.parameter),
          via: [...via, `${blockName(call.callerId)} → ${blockName(call.calleeId)}.${a.parameter}`],
        });
      }
    }
    // out of blocks: the symbol is a parameter; follow it to the callers' actual values
    const owner = ownerBlockId(id);
    const member = ctx.member(id);
    if (
      owner &&
      member &&
      (member.section === 'Input' || member.section === 'Output' || member.section === 'InOut')
    ) {
      for (const call of analysis.calls) {
        if (call.calleeId !== owner) continue;
        for (const a of call.args) {
          if (a.parameter?.toLowerCase() !== member.name.toLowerCase()) continue;
          const actual = argSymbol(call, a.value);
          if (actual)
            queue.push({
              id: actual,
              via: [...via, `${blockName(owner)}.${member.name} ← ${blockName(call.callerId)}`],
            });
        }
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.via.length - b.via.length || a.file.localeCompare(b.file) || a.range.start - b.range.start,
  );
}
