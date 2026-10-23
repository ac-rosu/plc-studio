// Prints the corpus gate report. Exit code 1 when a gate fails.
// Usage: node tools/corpus-harness/src/cli.ts [corpus folder]
import { fileURLToPath } from 'node:url';
import { corePrinter, projectChecker } from './core-adapters.ts';
import { renderReport } from './report.ts';
import { gatesPassed, runGates } from './run.ts';

const corpusRoot = process.argv[2] ?? fileURLToPath(new URL('../../../corpus', import.meta.url));
const run = await runGates(corpusRoot, corePrinter, projectChecker(corpusRoot));
process.stdout.write(renderReport(run));
process.exitCode = gatesPassed(run) ? 0 : 1;
