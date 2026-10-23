// Bundles the extension and the Node build of the language server into dist/, and copies the
// published JSON Schemas (for the jsonValidation contribution) and the LICENSE into the package.
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const production = process.argv.includes('--production');
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
} as const;

await build({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
});

await build({
  ...common,
  entryPoints: ['../language-server/src/node.ts'],
  outfile: 'dist/server.js',
});

await mkdir('schemas', { recursive: true });
for (const name of ['plc.schema.json', 'rules.schema.json']) {
  await cp(`../../schemas/${name}`, `schemas/${name}`);
}
await cp('../../LICENSE', 'LICENSE');
