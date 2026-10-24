// Integration tests in a real VS Code: builds the extension and the test suite, prepares a
// workspace from corpus files and runs VS Code with @vscode/test-electron.
// Usage (from packages/extension): node scripts/integration.mts
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('.');
const corpus = path.resolve('../../corpus/V21');

execFileSync(process.execPath, ['scripts/build.mts'], { stdio: 'inherit' });
await build({
  entryPoints: ['test/integration/suite.ts'],
  outfile: 'out/integration/suite.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  logLevel: 'warning',
});

const workspace = path.join(tmpdir(), 'plcstudio-integration');
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
const copy = (from: string, to = path.basename(from)) =>
  cpSync(path.join(corpus, from), path.join(workspace, to));
copy('C05-scl-sections/documents/FB_SclSections.s7dcl');
copy('C05-scl-sections/documents/FB_SclSections.s7res');
copy('C06-scl-types/documents/FC_SclTypes.s7dcl');
copy('C10-iec-check/documents/FC_IecOff.s7dcl');
copy('C07-scl-timers/documents/FB_SclTimers.s7dcl');
copy('C08-scl-calls/documents/FB_SclCalls.s7dcl');
copy('C08-scl-calls/documents/IDB_SclSections.s7dcl');
copy('C26k-dead-block/source/FC_AnaDead.scl', 'FC_Source.scl');
copy('C02-global-db/documents/DB_Machine.s7dcl');
copy('C02-global-db/documents/DB_Machine.s7res');
// external sources with several blocks (M13.2)
copy('C42-multi-block-sources/source/Types_V4.udt');
copy('C42-multi-block-sources/source/DBs_V4.db');
copy('C16-lad-contacts/documents/FC_LadContacts.s7dcl');
copy('C16-lad-contacts/documents/FC_LadContacts.s7res');
mkdirSync(path.join(workspace, 'PLC tags'));
copy('C04-tag-tables/tagtables/Tags_IO.xml', 'PLC tags/Tags_IO.xml');
writeFileSync(
  path.join(workspace, 'plc.json'),
  JSON.stringify(
    {
      name: 'Integration',
      cpu: { family: 'S7-1500' },
      tiaVersion: 'V21',
      displayLanguage: 'en-US',
    },
    null,
    2,
  ),
);
writeFileSync(
  path.join(workspace, 'FB_Broken.s7dcl'),
  [
    '{',
    '    S7_EditorMode := "SCL"',
    '}',
    'FUNCTION_BLOCK "FB_Broken"',
    '    VAR',
    '        Speed : Real;',
    '    END_VAR',
    '    { S7_Language := "SCL" }',
    '    NETWORK',
    '        ',
    '            #Speed := #Missing;',
    '        ',
    '    END_NETWORK',
    'END_FUNCTION_BLOCK',
    '',
  ].join('\r\n'),
);

// an OB that calls FC_SclTypes every cycle, for the call tree and the called-from summaries
writeFileSync(
  path.join(workspace, 'OB_Test.s7dcl'),
  [
    '{',
    '    S7_EditorMode := "SCL"',
    '}',
    'ORGANIZATION_BLOCK "OB_Test"',
    '    VAR_TEMP',
    '        Volume : Real;',
    '        Rounded : DInt;',
    '        Text : String;',
    '        Total : LReal;',
    '    END_VAR',
    '    { S7_Language := "SCL" }',
    '    NETWORK',
    '        ',
    '            #Volume := "FC_SclTypes"(InInt := 3, InReal := 1.5, OutDInt => #Rounded, OutText => #Text, Accumulator := #Total);',
    '            if #Volume>1.0 then',
    '            #Rounded:=0;',
    '            end_if;',
    '        ',
    '    END_NETWORK',
    'END_ORGANIZATION_BLOCK',
    '',
  ].join('\r\n'),
);

// When this script runs from inside VS Code, the variable would start VS Code as plain Node.
delete process.env['ELECTRON_RUN_AS_NODE'];

await runTests({
  extensionDevelopmentPath: extensionPath,
  extensionTestsPath: path.resolve('out/integration/suite.js'),
  launchArgs: [
    workspace,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
  ],
});
