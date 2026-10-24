// Registers the analyzer and the cross-block rules as analysis passes (imported for its side
// effect by core's index). Severities follow plcstudio.rules.json; analyzer rules never report
// errors, except the recursion policy error (ADR 0013).
import { ownerOf, registerFilter, registerPass, type ProjectAnalysis } from '../check/analysis.ts';
import type { Reference } from '../check/binder.ts';
import { ruleInfo } from '../check/rules.ts';
import { crossBlockFindings } from '../callgraph/cross-block.ts';
import { callGraph } from '../callgraph/graph.ts';
import type { LocatedDiagnostic, Project } from '../model/project.ts';
import { effectiveSeverity } from './config.ts';
import { AnalyzerContext } from './context.ts';
import { customFindings } from './custom.ts';
import { namingFindings } from './naming.ts';
import { SingleBlockRules, type BlockFacts, type Finding } from './single-block.ts';
import { applySuppressions } from './suppression.ts';

interface SingleBlockResult {
  /** The binding the findings were computed from (the same array while it is reused). */
  readonly references: readonly Reference[];
  readonly settings: number;
  /**
   * Owners whose references the rules looked up (undefined: the rules read all references, so
   * the result is never reused).
   */
  readonly interest: ReadonlySet<string> | undefined;
  readonly findings: readonly Finding[];
  readonly facts: BlockFacts;
}

/**
 * The project's references by symbol, recording which symbols the single-block rules of one
 * block look up: those lookups are the only thing the rules read from other blocks' bindings.
 */
class RecordingReferences implements ReadonlyMap<string, readonly Reference[]> {
  private readonly inner: ReadonlyMap<string, readonly Reference[]>;
  looked: Set<string> | undefined;
  everything = false;

  constructor(inner: ReadonlyMap<string, readonly Reference[]>) {
    this.inner = inner;
  }

  get(id: string): readonly Reference[] | undefined {
    this.looked?.add(id);
    return this.inner.get(id);
  }

  has(id: string): boolean {
    this.looked?.add(id);
    return this.inner.has(id);
  }

  get size(): number {
    this.everything = true;
    return this.inner.size;
  }

  forEach(
    callback: (
      value: readonly Reference[],
      key: string,
      map: ReadonlyMap<string, readonly Reference[]>,
    ) => void,
  ): void {
    this.everything = true;
    this.inner.forEach(callback);
  }

  entries(): MapIterator<[string, readonly Reference[]]> {
    this.everything = true;
    return this.inner.entries();
  }

  keys(): MapIterator<string> {
    this.everything = true;
    return this.inner.keys();
  }

  values(): MapIterator<readonly Reference[]> {
    this.everything = true;
    return this.inner.values();
  }

  [Symbol.iterator](): MapIterator<[string, readonly Reference[]]> {
    return this.entries();
  }
}

const singleBlockCache = new WeakMap<Project, Map<string, SingleBlockResult>>();

/** Whether a member of the (small) first set is in the second. */
function someIn(few: ReadonlySet<string>, set: ReadonlySet<string>): boolean {
  for (const x of few) if (set.has(x)) return true;
  return false;
}

/**
 * Findings of every analyzer and cross-block rule, before severities are applied. Single-block
 * rules run again only for blocks bound again, and for blocks that read references of an owner
 * whose references changed (M6.8); cross-block rules run over the cached per-block facts.
 */
export function analyzerFindings(project: Project, analysis: ProjectAnalysis): Finding[] {
  const recording = new RecordingReferences(analysis.referencesBySymbol);
  // the analysis with recorded lookups; its other members stay the analysis' own (lazy) ones
  const view = Object.create(analysis, {
    referencesBySymbol: { value: recording },
  }) as ProjectAnalysis;
  const ctx = new AnalyzerContext(project, view);
  const config = project.rules;
  const findings: Finding[] = [];
  const facts = new Map<string, BlockFacts>();
  const previous = singleBlockCache.get(project);
  const current = new Map<string, SingleBlockResult>();
  const touched = analysis.changes.full ? undefined : analysis.changes.touchedOwners;
  let analyzed = 0;
  for (const ba of analysis.blocks.values()) {
    const key = `${ba.symbol.file.path}\n${ba.symbol.id}`;
    let result = previous?.get(key);
    if (
      !result ||
      !touched ||
      result.references !== ba.references ||
      result.settings !== project.settingsRevision ||
      !result.interest ||
      someIn(touched, result.interest)
    ) {
      recording.looked = new Set();
      recording.everything = false;
      const rules = new SingleBlockRules(ctx, ba.symbol, ba, config);
      const blockFindings = rules.run();
      const interest = new Set<string>([ba.symbol.id]);
      for (const id of recording.looked) interest.add(ownerOf(id));
      result = {
        references: ba.references,
        settings: project.settingsRevision,
        interest: recording.everything ? undefined : interest,
        findings: blockFindings,
        facts: { outputsNotAlwaysWritten: rules.outputsNotAlwaysWritten },
      };
      recording.looked = undefined;
      analyzed++;
    }
    current.set(key, result);
    findings.push(...result.findings);
    facts.set(ba.symbol.id, result.facts);
  }
  singleBlockCache.set(project, current);
  analysis.stats.analyzedBlocks = analyzed;
  findings.push(...crossBlockFindings(ctx, callGraph(project, analysis), facts));
  findings.push(...customFindings(ctx, config));
  findings.push(...namingFindings(ctx, config));
  return findings;
}

function toDiagnostics(project: Project, findings: readonly Finding[]): LocatedDiagnostic[] {
  const config = project.rules;
  const custom = new Map(config.custom.map((c) => [c.id, c.severity]));
  const out: LocatedDiagnostic[] = [];
  for (const f of findings) {
    const base =
      f.severity ??
      (custom.get(f.rule) as LocatedDiagnostic['severity'] | 'off' | undefined) ??
      ruleInfo(f.rule)?.severity ??
      'warning';
    if (base === 'off') continue;
    const severity = effectiveSeverity(config, f.rule, base);
    if (severity === 'off') continue;
    out.push({ file: f.file, range: f.range, message: f.message, severity, code: f.rule });
  }
  return out;
}

registerPass((project, analysis) => toDiagnostics(project, analyzerFindings(project, analysis)));
registerFilter((project, _analysis, diagnostics) => applySuppressions(project, diagnostics));
