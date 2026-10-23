// Production build, then a .vsix in the repository's dist/ folder. Fails if the package would
// contain anything outside the allowlist (no corpus, tests, sources or source maps).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const run = (args: string[]): string =>
  execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

rmSync('dist', { recursive: true, force: true });
run(['scripts/build.mts', '--production']);

const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^images\/icon\.png$/,
  /^images\/activity\.svg$/,
  /^schemas\/[a-z]+\.schema\.json$/,
  /^dist\/(extension|server)\.js$/,
  /^dist\/webviews\/[a-z-]+\.(js|css)$/,
  /^syntaxes\/[a-z0-9-]+\.tmLanguage\.json$/,
  /^language-configuration\.json$/,
];
const files = run([vsce, 'ls', '--no-dependencies'])
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => line.replace(/\\/g, '/'));
const unexpected = files.filter((file) => !ALLOWED.some((pattern) => pattern.test(file)));
if (unexpected.length > 0) {
  console.error(`Files not allowed in the package:\n  ${unexpected.join('\n  ')}`);
  process.exit(1);
}

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  name: string;
  version: string;
};
const out = path.resolve('..', '..', 'dist', `${name}-${version}.vsix`);
mkdirSync(path.dirname(out), { recursive: true });
run([vsce, 'package', '--no-dependencies', '--out', out]);
console.log(`Packaged ${files.length} files into ${out}`);
