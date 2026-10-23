// Registers the analyzer and the cross-block rules as analysis passes (imported for its side
// effect by core's index). Severities follow plcstudio.rules.json; analyzer rules never report
// errors, except the recursion policy error (ADR 0013).
import { registerFilter, registerPass, type ProjectAnalysis } from '../check/analysis.ts';
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

/** Findings of every analyzer and cross-block rule, before severities are applied. */
export function analyzerFindings(project: Project, analysis: ProjectAnalysis): Finding[] {
  const ctx = new AnalyzerContext(project, analysis);
  const config = project.rules;
  const findings: Finding[] = [];
  const facts = new Map<string, BlockFacts>();
  for (const ba of analysis.blocks.values()) {
    const rules = new SingleBlockRules(ctx, ba.symbol, ba, config);
    findings.push(...rules.run());
    facts.set(ba.symbol.id, { outputsNotAlwaysWritten: rules.outputsNotAlwaysWritten });
  }
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
