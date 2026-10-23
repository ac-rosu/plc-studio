// Lists the TIA errors the checker misses and every warning or error on TIA-clean cases.
// Usage: node tools/corpus-harness/src/inspect.ts [documents|vci|source] [all]
import { fileURLToPath } from 'node:url';
import { assemblePlcs, isTiaClean, loadCases } from './corpus.ts';
import { errorCoverage } from './gates.ts';
import { projectChecker } from './core-adapters.ts';
const root = fileURLToPath(new URL('../../../corpus', import.meta.url));
const variant = (process.argv[2] ?? 'documents') as 'documents';
const cases = loadCases(root, 'V21');
for (const plc of assemblePlcs(cases, variant)) {
  const diags = await projectChecker(root).check(plc);
  const cov = errorCoverage(plc, diags);
  for (const e of cov.entries.filter((x) => !x.matched))
    console.log('MISSED', e.caseFolder, e.block, e.where, '|', e.description.slice(0, 100));
  const byCase = new Map(plc.cases.map((c) => [c.folder, c]));
  for (const d of diags) {
    const owners = plc.owners.get(d.file) ?? [];
    const clean = owners.some((o) => isTiaClean(byCase.get(o)!));
    if (process.argv[3] === 'all' || (clean && d.severity !== 'info'))
      console.log(
        clean ? 'CLEAN' : 'broken',
        d.severity.padEnd(7),
        d.ruleId.padEnd(24),
        `${owners[0]}/${d.file.path}:${d.line}`,
        d.message.slice(0, 110),
      );
  }
}
