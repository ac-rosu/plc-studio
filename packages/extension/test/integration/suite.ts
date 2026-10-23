// Integration tests inside a real VS Code (spec M4: integration tests for each feature). Runs in
// the extension host; scripts/integration.mts prepares the workspace and starts VS Code.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface Test {
  name: string;
  run: () => Promise<void>;
}

const tests: Test[] = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });

const root = () => vscode.workspace.workspaceFolders![0]!.uri;
const file = (name: string) => vscode.Uri.joinPath(root(), name);

async function until<T>(f: () => T | undefined | Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function open(name: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(file(name));
  await vscode.window.showTextDocument(doc);
  return doc;
}

function position(doc: vscode.TextDocument, needle: string, delta = 0): vscode.Position {
  return doc.positionAt(doc.getText().indexOf(needle) + delta);
}

test('the extension activates and owns its languages', async () => {
  const ext = vscode.extensions.getExtension('acro.plcstudio');
  assert.ok(ext, 'extension found');
  await ext.activate();
  const doc = await open('FB_SclCalls.s7dcl');
  assert.equal(doc.languageId, 'plcstudio-s7dcl');
  const scl = await vscode.workspace.openTextDocument(file('FC_Source.scl'));
  assert.equal(scl.languageId, 'plcstudio-scl');
});

test('diagnostics: an error for broken code, none for corpus code TIA compiles', async () => {
  await open('FB_Broken.s7dcl');
  const broken = await until(() => {
    const d = vscode.languages.getDiagnostics(file('FB_Broken.s7dcl'));
    return d.length > 0 ? d : undefined;
  });
  assert.equal(broken[0]!.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(broken[0]!.code, 'undeclared-local');
  const clean = vscode.languages
    .getDiagnostics(file('FB_SclCalls.s7dcl'))
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
  assert.deepEqual(clean, []);
});

test('hover, definition and references', async () => {
  const doc = await open('FB_SclCalls.s7dcl');
  const at = position(doc, '"FC_SclTypes"', 2);
  const hovers = await until(async () => {
    const h = (await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      doc.uri,
      at,
    )) as vscode.Hover[];
    return h.length > 0 ? h : undefined;
  });
  const text = hovers
    .flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)))
    .join('\n');
  assert.match(text, /FC_SclTypes/);
  const defs = (await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider',
    doc.uri,
    at,
  )) as (vscode.Location | vscode.LocationLink)[];
  const target = 'uri' in defs[0]! ? defs[0].uri : defs[0]!.targetUri;
  assert.match(target.path, /FC_SclTypes\.s7dcl$/);
  const refs = (await vscode.commands.executeCommand(
    'vscode.executeReferenceProvider',
    doc.uri,
    at,
  )) as vscode.Location[];
  assert.ok(refs.length >= 1);
});

test('completion and signature help', async () => {
  const doc = await open('FB_SclCalls.s7dcl');
  const list = (await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider',
    doc.uri,
    position(doc, '#Sections(', 1),
    '#',
  )) as vscode.CompletionList;
  assert.ok(
    list.items.some((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'Sections'),
  );
  const help = (await vscode.commands.executeCommand(
    'vscode.executeSignatureHelpProvider',
    doc.uri,
    position(doc, 'Mode := #Mode'),
    ',',
  )) as vscode.SignatureHelp | undefined;
  assert.ok(help && help.signatures.length > 0);
});

test('outline, folding and semantic tokens', async () => {
  const doc = await open('FB_SclCalls.s7dcl');
  const symbols = (await vscode.commands.executeCommand(
    'vscode.executeDocumentSymbolProvider',
    doc.uri,
  )) as vscode.DocumentSymbol[];
  assert.equal(symbols[0]!.name, 'FB_SclCalls');
  const folds = (await vscode.commands.executeCommand(
    'vscode.executeFoldingRangeProvider',
    doc.uri,
  )) as vscode.FoldingRange[];
  assert.ok(folds.length > 3);
  const tokens = (await vscode.commands.executeCommand(
    'vscode.provideDocumentSemanticTokens',
    doc.uri,
  )) as vscode.SemanticTokens | undefined;
  assert.ok(tokens && tokens.data.length > 0);
});

test('rename across files', async () => {
  const doc = await open('FB_SclSections.s7dcl');
  const edit = (await vscode.commands.executeCommand(
    'vscode.executeDocumentRenameProvider',
    doc.uri,
    position(doc, 'Enable : Bool', 1),
    'Enabled',
  )) as vscode.WorkspaceEdit;
  assert.ok(edit.entries().length >= 2);
});

test('quick fix: declare a variable', async () => {
  const doc = await open('FB_Broken.s7dcl');
  const d = vscode.languages.getDiagnostics(doc.uri)[0]!;
  const actions = (await vscode.commands.executeCommand(
    'vscode.executeCodeActionProvider',
    doc.uri,
    d.range,
    vscode.CodeActionKind.QuickFix.value,
  )) as vscode.CodeAction[];
  assert.ok(actions.some((a) => a.title.startsWith('Declare #Missing')));
});

test('commands are registered', async () => {
  const commands = await vscode.commands.getCommands(true);
  for (const c of [
    'plcstudio.createManifest',
    'plcstudio.showProfileCoverage',
    'plcstudio.restartServer',
    'plcstudio.useForPlcFiles',
  ]) {
    assert.ok(commands.includes(c), c);
  }
});

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
    } catch (e) {
      console.log(`  FAIL ${t.name}: ${(e as Error).message}`);
      failures.push(t.name);
    }
  }
  console.log(`${tests.length - failures.length}/${tests.length} integration tests passed`);
  if (failures.length > 0) throw new Error(`${failures.length} integration test(s) failed`);
}
