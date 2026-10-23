// Bundles core for a platform without Node built-ins. The build fails if core reaches
// for a Node module, which backs up the web-safety lint rules (ADR 0006).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2023',
  outfile: 'dist/core.js',
  logLevel: 'warning',
});
