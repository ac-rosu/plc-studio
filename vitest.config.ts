import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.test.ts',
            'tools/*/src/**/*.test.ts',
            'schemas/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/*.corpus.test.ts', '**/*.web.test.ts'],
        },
      },
      {
        test: {
          name: 'corpus',
          include: ['tools/corpus-harness/src/**/*.corpus.test.ts'],
          testTimeout: 120_000,
        },
      },
      {
        // core and language-server must run in a browser (ADR 0006); *.web.test.ts files
        // additionally start the language server in a real Web Worker.
        optimizeDeps: {
          include: [
            'vscode-languageserver',
            'vscode-languageserver/browser',
            'vscode-languageserver-textdocument',
          ],
        },
        test: {
          name: 'web',
          include: [
            'packages/core/src/**/*.test.ts',
            'packages/language-server/src/**/*.test.ts',
            'packages/webviews/src/**/*.web.test.ts',
          ],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
