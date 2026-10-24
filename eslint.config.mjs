import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

const NODE_MODULES = [...new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))];

// ADR 0006: core and language-server run in a browser worker too.
const WEB_SAFE_IMPORTS = [
  ...NODE_MODULES.map((name) => ({
    name,
    message: 'core and language-server are web-safe (ADR 0006).',
  })),
  { name: 'vscode', message: 'core and language-server must not use the VS Code API (ADR 0006).' },
];
const WEB_SAFE_GLOBALS = [
  'process',
  'Buffer',
  'global',
  'require',
  '__dirname',
  '__filename',
  'setImmediate',
].map((name) => ({
  name,
  message: 'Node global; core and language-server are web-safe (ADR 0006).',
}));

// ADR 0008: no network calls, ever. Links are opened only by the user.
const NETWORK_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
].map((name) => ({ name, message: 'No network calls (ADR 0008).' }));
const NETWORK_IMPORTS = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns'].flatMap((name) =>
  [name, `node:${name}`].map((spec) => ({ name: spec, message: 'No network calls (ADR 0008).' })),
);

export default defineConfig(
  {
    ignores: [
      '.claude/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.vscode-test/**',
      'corpus/**',
      'corpus-private/**',
      // local experiments, never committed
      '.scratch/**',
      'packages/extension/schemas/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,mts}'],
    languageOptions: { globals: { ...globals.es2023 } },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...NETWORK_GLOBALS],
      'no-restricted-imports': ['error', { paths: NETWORK_IMPORTS }],
    },
  },
  {
    files: ['packages/core/src/**/*.ts', 'packages/language-server/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...NETWORK_GLOBALS, ...WEB_SAFE_GLOBALS],
      'no-restricted-imports': [
        'error',
        {
          paths: WEB_SAFE_IMPORTS,
          patterns: [
            {
              group: [
                'vscode-languageserver/node',
                'vscode-languageserver-protocol/node',
                'vscode-jsonrpc/node',
              ],
              message:
                'Only the Node entry point (language-server/src/node.ts) may use the Node transport.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/language-server/src/node.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: WEB_SAFE_IMPORTS }],
    },
  },
  {
    files: [
      'packages/extension/src/**/*.ts',
      '**/scripts/**',
      'tools/**',
      '*.config.*',
      'eslint.config.mjs',
      'schemas/**',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
