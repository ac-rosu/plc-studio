// Bundles the extension, the Node build of the language server and every webview into dist/, and
// copies the published JSON Schemas (for the jsonValidation contribution) and the LICENSE into
// the package.
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';

const production = process.argv.includes('--production');
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
} as const;

await build({
  ...common,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
});

await build({
  ...common,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  entryPoints: ['../language-server/src/node.ts'],
  outfile: 'dist/server.js',
});

// Webviews: every packages/webviews/src/<view>/main.ts becomes dist/webviews/<view>.js
const webviewRoot = '../webviews/src';
const views = readdirSync(webviewRoot, { withFileTypes: true })
  .filter(
    (d) => d.isDirectory() && d.name !== 'shared' && existsSync(`${webviewRoot}/${d.name}/main.ts`),
  )
  .map((d) => d.name);
await mkdir('dist/webviews', { recursive: true });
for (const view of views) {
  await build({
    ...common,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    entryPoints: [`${webviewRoot}/${view}/main.ts`],
    outfile: `dist/webviews/${view}.js`,
    loader: { '.css': 'text' },
  });
}
await cp(`${webviewRoot}/shared/base.css`, 'dist/webviews/base.css');

await mkdir('schemas', { recursive: true });
for (const name of ['plc.schema.json', 'rules.schema.json']) {
  await cp(`../../schemas/${name}`, `schemas/${name}`);
}
await cp('../../LICENSE', 'LICENSE');
