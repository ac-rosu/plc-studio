// Markdown report of a gate run.
import { isTiaClean } from './corpus.ts';
import { gatesPassed, type GateRun } from './run.ts';

const pct = (part: number, whole: number) =>
  whole === 0 ? '–' : `${Math.round((100 * part) / whole)}%`;

export function renderReport(run: GateRun): string {
  const out: string[] = [
    '# Corpus gate report',
    '',
    `Parser: ${run.printer} · Checker: ${run.checker} · Gates: **${gatesPassed(run) ? 'passed' : 'FAILED'}**`,
  ];
  for (const v of run.versions) {
    const count = (kind: string) => v.cases.filter((c) => c.expected.kind === kind).length;
    out.push(
      '',
      `## ${v.version}`,
      '',
      `${v.cases.length} cases: ${count('clean')} clean, ${count('analyzer')} analyzer, ${count('broken')} broken; ` +
        `${v.cases.filter((c) => isTiaClean(c)).length} compile cleanly in TIA.`,
      '',
      `Round trip: ${v.roundTrip.checked - v.roundTrip.failures.length}/${v.roundTrip.checked} files byte-identical.`,
      ...v.roundTrip.failures.map((f) => `- ${f.caseFolder}/${f.file.path}: ${f.problem}`),
      '',
      '| PLC | Variant | Files | False errors | Error coverage | Policy errors found | Analyzer expectations found |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...v.plcs.map((p) => {
        const policyFound = p.policy.filter((r) => r.found).length;
        const analyzerFound = p.analyzer.filter((r) => r.found).length;
        return (
          `| ${p.plc} | ${p.variant} | ${p.files} | ${p.falseErrors.length} | ` +
          `${p.coverage.matched}/${p.coverage.expected} (${pct(p.coverage.matched, p.coverage.expected)}) | ` +
          `${policyFound}/${p.policy.length} | ${analyzerFound}/${p.analyzer.length} |`
        );
      }),
    );
    const missedAnalyzer = v.plcs.flatMap((p) =>
      p.analyzer.filter((r) => !r.found).map((r) => ({ ...r, variant: p.variant })),
    );
    if (missedAnalyzer.length > 0) {
      out.push('', '### Analyzer expectations not found', '');
      for (const r of missedAnalyzer) {
        out.push(
          `- ${r.variant} · ${r.caseFolder} · ${r.rule} in ${r.block}${r.line !== null ? ` line ${r.line}` : ''}${r.member ? ` (${r.member})` : ''}`,
        );
      }
    }
    const falseErrors = v.plcs.flatMap((p) =>
      p.falseErrors.map((f) => ({ ...f, variant: p.variant })),
    );
    if (falseErrors.length > 0) {
      out.push('', '### False errors', '');
      for (const f of falseErrors) {
        const d = f.diagnostic;
        out.push(
          `- ${f.variant} · ${f.caseFolder}/${d.file.path}:${d.line} · ${d.ruleId}: ${d.message}`,
        );
      }
    }
  }
  return out.join('\n') + '\n';
}
