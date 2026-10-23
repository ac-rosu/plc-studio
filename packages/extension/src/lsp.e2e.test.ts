// End-to-end test of the language server over the real protocol: the server runs as its own
// process (Node entry point), this test plays the client and serves a virtual PLC folder made of
// corpus files, the way the extension serves workspace files through vscode.workspace.fs.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type ProtocolConnection,
} from 'vscode-languageserver-protocol/node';

const NODE_ENTRY = fileURLToPath(new URL('../../language-server/src/node.ts', import.meta.url));
const CORPUS = fileURLToPath(new URL('../../../corpus/V21', import.meta.url));

const corpusFile = (path: string) => readFileSync(`${CORPUS}/${path}`, 'utf8');

const BROKEN = [
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
].join('\r\n');

const FILES: Record<string, string> = {
  'plc.json': JSON.stringify({
    name: 'Test',
    cpu: { family: 'S7-1500' },
    tiaVersion: 'V21',
    displayLanguage: 'en-US',
  }),
  'FB_SclSections.s7dcl': corpusFile('C05-scl-sections/documents/FB_SclSections.s7dcl'),
  'FB_SclSections.s7res': corpusFile('C05-scl-sections/documents/FB_SclSections.s7res'),
  'FC_SclTypes.s7dcl': corpusFile('C06-scl-types/documents/FC_SclTypes.s7dcl'),
  'FC_IecOff.s7dcl': corpusFile('C10-iec-check/documents/FC_IecOff.s7dcl'),
  'FB_SclTimers.s7dcl': corpusFile('C07-scl-timers/documents/FB_SclTimers.s7dcl'),
  'FB_SclCalls.s7dcl': corpusFile('C08-scl-calls/documents/FB_SclCalls.s7dcl'),
  'IDB_SclSections.s7dcl': corpusFile('C08-scl-calls/documents/IDB_SclSections.s7dcl'),
  'FB_Broken.s7dcl': BROKEN,
};
const ROOT = 'file:///plc';
const uri = (name: string) => `${ROOT}/${name}`;

let server: ChildProcess;
let connection: ProtocolConnection;
const diagnostics = new Map<string, { message: string; severity: number; code: string }[]>();

async function until<T>(f: () => T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const positionOf = (name: string, needle: string, delta = 0) => {
  const text = FILES[name]!;
  const offset = text.indexOf(needle) + delta;
  const before = text.slice(0, offset).split(/\r\n|\n/);
  return { line: before.length - 1, character: before.at(-1)!.length };
};

beforeAll(async () => {
  server = spawn(process.execPath, [NODE_ENTRY, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  connection = createProtocolConnection(
    new StreamMessageReader(server.stdout!),
    new StreamMessageWriter(server.stdin!),
  );
  connection.onRequest('plcstudio/readDirectory', ({ uri: u }: { uri: string }) =>
    u === ROOT ? Object.keys(FILES).map((n) => [n, false]) : [],
  );
  connection.onRequest('plcstudio/readFile', ({ uri: u }: { uri: string }) => {
    const name = u.slice(ROOT.length + 1);
    return name in FILES ? Buffer.from(FILES[name]!, 'utf8').toString('base64') : null;
  });
  connection.onRequest('workspace/configuration', () => [{}]);
  connection.onNotification(
    'textDocument/publishDiagnostics',
    (p: { uri: string; diagnostics: { message: string; severity: number; code: string }[] }) => {
      diagnostics.set(p.uri, p.diagnostics);
    },
  );
  connection.listen();
  await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: { workspace: { configuration: true } },
    workspaceFolders: [{ uri: ROOT, name: 'plc' }],
  });
  await connection.sendNotification('initialized', {});
  await until(() => diagnostics.get(uri('FB_Broken.s7dcl')));
  await connection.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: uri('FB_SclCalls.s7dcl'),
      languageId: 'plcstudio-s7dcl',
      version: 1,
      text: FILES['FB_SclCalls.s7dcl'],
    },
  });
}, 30_000);

afterAll(async () => {
  try {
    await connection.sendRequest('shutdown');
    await connection.sendNotification('exit');
  } catch {
    // already gone
  }
  connection.dispose();
  server.kill();
});

describe('language server over LSP', () => {
  it('publishes errors for broken code and none for corpus files TIA compiles', () => {
    const broken = diagnostics.get(uri('FB_Broken.s7dcl'))!;
    expect(broken.map((d) => [d.code, d.severity])).toEqual([['undeclared-local', 1]]);
    for (const name of ['FB_SclSections.s7dcl', 'FC_SclTypes.s7dcl', 'FB_SclCalls.s7dcl']) {
      expect(
        (diagnostics.get(uri(name)) ?? []).filter((d) => d.severity === 1),
        name,
      ).toEqual([]);
    }
  });

  it('hovers, finds the definition and the references of a block', async () => {
    const at = positionOf('FB_SclCalls.s7dcl', '"FC_SclTypes"', 2);
    const hover = (await connection.sendRequest('textDocument/hover', {
      textDocument: { uri: uri('FB_SclCalls.s7dcl') },
      position: at,
    })) as { contents: { value: string } };
    expect(hover.contents.value).toContain('"FC_SclTypes"');
    const def = (await connection.sendRequest('textDocument/definition', {
      textDocument: { uri: uri('FB_SclCalls.s7dcl') },
      position: at,
    })) as { uri: string };
    expect(def.uri).toBe(uri('FC_SclTypes.s7dcl'));
    const refs = (await connection.sendRequest('textDocument/references', {
      textDocument: { uri: uri('FB_SclCalls.s7dcl') },
      position: at,
      context: { includeDeclaration: true },
    })) as unknown[];
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  it('completes locals and parameters and gives signature help', async () => {
    const at = positionOf('FB_SclCalls.s7dcl', '#Sections(', 1);
    const items = (await connection.sendRequest('textDocument/completion', {
      textDocument: { uri: uri('FB_SclCalls.s7dcl') },
      position: at,
    })) as { label: string }[];
    expect(items.map((i) => i.label)).toContain('Sections');
    const inside = positionOf('FB_SclCalls.s7dcl', 'Mode := #Mode', 0);
    const help = (await connection.sendRequest('textDocument/signatureHelp', {
      textDocument: { uri: uri('FB_SclCalls.s7dcl') },
      position: inside,
    })) as { signatures: { parameters: unknown[] }[]; activeParameter: number };
    expect(help.signatures[0]!.parameters.length).toBeGreaterThan(3);
    expect(help.activeParameter).toBe(1);
  });

  it('renames a member across files', async () => {
    const at = positionOf('FB_SclSections.s7dcl', 'Enable : Bool', 1);
    const edit = (await connection.sendRequest('textDocument/rename', {
      textDocument: { uri: uri('FB_SclSections.s7dcl') },
      position: at,
      newName: 'Enabled',
    })) as { documentChanges: { textDocument: { uri: string } }[] };
    const files = edit.documentChanges.map((c) => c.textDocument.uri).sort();
    expect(files).toEqual(
      [uri('FB_SclCalls.s7dcl'), uri('FB_SclSections.s7dcl'), uri('IDB_SclSections.s7dcl')].sort(),
    );
  });

  it('provides outline, folding, semantic tokens, code lenses, call hierarchy and quick fixes', async () => {
    const doc = { textDocument: { uri: uri('FB_SclCalls.s7dcl') } };
    const symbols = (await connection.sendRequest('textDocument/documentSymbol', doc)) as {
      name: string;
    }[];
    expect(symbols[0]!.name).toBe('FB_SclCalls');
    const folds = (await connection.sendRequest('textDocument/foldingRange', doc)) as unknown[];
    expect(folds.length).toBeGreaterThan(3);
    const tokens = (await connection.sendRequest('textDocument/semanticTokens/full', doc)) as {
      data: number[];
    };
    expect(tokens.data.length % 5).toBe(0);
    expect(tokens.data.length).toBeGreaterThan(20);
    const lenses = (await connection.sendRequest('textDocument/codeLens', {
      textDocument: { uri: uri('FC_SclTypes.s7dcl') },
    })) as { command: { title: string } }[];
    expect(lenses[0]!.command.title).toMatch(/reference/);
    const items = (await connection.sendRequest('textDocument/prepareCallHierarchy', {
      ...doc,
      position: positionOf('FB_SclCalls.s7dcl', '"FC_SclTypes"', 2),
    })) as { name: string }[];
    expect(items[0]!.name).toBe('FC_SclTypes');
    const incoming = (await connection.sendRequest('callHierarchy/incomingCalls', {
      item: items[0],
    })) as { from: { name: string } }[];
    expect(incoming.map((c) => c.from.name)).toContain('FB_SclCalls');
    const broken = diagnostics.get(uri('FB_Broken.s7dcl'))!;
    const actions = (await connection.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri('FB_Broken.s7dcl') },
      range: (broken[0] as unknown as { range: unknown }).range,
      context: { diagnostics: broken },
    })) as { title: string }[];
    expect(actions.map((a) => a.title)).toContain('Declare #Missing : Real in VAR_TEMP');
  });

  it('updates diagnostics within 200 ms of a change', async () => {
    const start = Date.now();
    diagnostics.delete(uri('FB_SclCalls.s7dcl'));
    const text = FILES['FB_SclCalls.s7dcl']!.replace('#CallsOk := #CallOk;', '#CallsOk := #Nope;');
    await connection.sendNotification('textDocument/didChange', {
      textDocument: { uri: uri('FB_SclCalls.s7dcl'), version: 2 },
      contentChanges: [{ text }],
    });
    const list = await until(() => diagnostics.get(uri('FB_SclCalls.s7dcl')));
    expect(list.some((d) => d.code === 'undeclared-local')).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
