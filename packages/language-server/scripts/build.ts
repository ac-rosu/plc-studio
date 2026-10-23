// Bundles both entry points. The browser bundle must build for a platform without Node,
// which backs up the web-safety lint rules (ADR 0006).
import { build } from 'esbuild';

const common = { bundle: true, target: 'es2023', logLevel: 'warning' } as const;

await build({
  ...common,
  entryPoints: ['src/node.ts'],
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/node.cjs',
});

await build({
  ...common,
  entryPoints: ['src/browser.ts'],
  platform: 'browser',
  format: 'iife',
  outfile: 'dist/browser.js',
});
