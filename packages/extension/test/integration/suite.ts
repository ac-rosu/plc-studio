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

test('formatting: the whole document, and only the changed lines', async () => {
  const doc = await open('OB_Test.s7dcl');
  const edits = (await vscode.commands.executeCommand(
    'vscode.executeFormatDocumentProvider',
    doc.uri,
    { tabSize: 4, insertSpaces: true },
  )) as vscode.TextEdit[];
  const lines = [...new Set(edits.map((e) => e.range.start.line))].sort((a, b) => a - b);
  assert.deepEqual(lines, [14, 15, 16]);
  const edit = new vscode.WorkspaceEdit();
  edit.set(doc.uri, edits);
  await vscode.workspace.applyEdit(edit);
  assert.match(doc.lineAt(14).text, /^ {12}IF #Volume > 1\.0 THEN$/);
  assert.match(doc.lineAt(15).text, /^ {16}#Rounded := 0;$/);
  await vscode.commands.executeCommand('workbench.action.files.revert');
});

test('called-from summary in CodeLens; call tree and Trace value views', async () => {
  const doc = await open('FC_SclTypes.s7dcl');
  const lenses = await until(async () => {
    const l = (await vscode.commands.executeCommand(
      'vscode.executeCodeLensProvider',
      doc.uri,
    )) as vscode.CodeLens[];
    return l.some((x) => x.command?.title.includes('OB_Test')) ? l : undefined;
  });
  assert.match(lenses[0]!.command!.title, /called from OB_Test every cycle/);
  await vscode.commands.executeCommand('workbench.view.extension.plcstudio');
  await vscode.commands.executeCommand('plcstudio.refreshCallTree');
  const ob = await open('OB_Test.s7dcl');
  await vscode.commands.executeCommand('plcstudio.traceValue', ob.uri, position(ob, '#Rounded', 2));
  await vscode.commands.executeCommand('plcstudio.clearTrace');
});

/** Opens a file in a custom editor and waits for its tab. */
async function openWith(name: string, viewType: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', file(name), viewType);
  await until(() =>
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find(
        (t) =>
          t.input instanceof vscode.TabInputCustom &&
          t.input.viewType === viewType &&
          t.input.uri.toString() === file(name).toString(),
      ),
  );
}

interface ViewHealth {
  rendered: string[];
  renders: Record<string, number>;
  errors: string[];
}

const health = async () =>
  (await vscode.commands.executeCommand('plcstudio.internal.viewHealth')) as ViewHealth;

/** Waits until the view type has drawn an update without a script error. */
async function rendered(viewType: string): Promise<void> {
  const health = await until(async () => {
    const h = (await vscode.commands.executeCommand('plcstudio.internal.viewHealth')) as ViewHealth;
    return h.rendered.includes(viewType) || h.errors.length > 0 ? h : undefined;
  });
  assert.deepEqual(health.errors, []);
}

test('custom editors render: LAD/FBD, interface, data block, translations, tag table', async () => {
  for (const [name, viewType] of [
    ['FC_LadContacts.s7dcl', 'plcstudio.ladderEditor'],
    ['FB_SclSections.s7dcl', 'plcstudio.interfaceEditor'],
    ['DB_Machine.s7dcl', 'plcstudio.dataBlockEditor'],
    ['FB_SclSections.s7dcl', 'plcstudio.translationTable'],
    ['PLC tags/Tags_IO.xml', 'plcstudio.tagTableEditor'],
    ['DBs_V4.db', 'plcstudio.dataBlockEditor'],
    ['Types_V4.udt', 'plcstudio.interfaceEditor'],
  ] as const) {
    // a new render each time: the same view type opens twice (one block, several blocks)
    const before = (await health()).renders[viewType] ?? 0;
    await openWith(name, viewType);
    const h = await until(async () => {
      const now = await health();
      return (now.renders[viewType] ?? 0) > before || now.errors.length > 0 ? now : undefined;
    });
    assert.deepEqual(h.errors, [], name);
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('opening a file picks the view that fits its content', async () => {
  for (const [name, viewType] of [
    ['FC_LadContacts.s7dcl', 'plcstudio.ladderEditor'],
    ['DB_Machine.s7dcl', 'plcstudio.dataBlockEditor'],
    ['DBs_V4.db', 'plcstudio.dataBlockEditor'],
    ['Types_V4.udt', 'plcstudio.interfaceEditor'],
  ] as const) {
    const before = (await health()).renders[viewType] ?? 0;
    await vscode.commands.executeCommand('vscode.open', file(name));
    const h = await until(async () => {
      const now = await health();
      return (now.renders[viewType] ?? 0) > before || now.errors.length > 0 ? now : undefined;
    });
    assert.deepEqual(h.errors, [], name);
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(
      input instanceof vscode.TabInputCustom && input.viewType === 'plcstudio.matchingView',
      name,
    );
  }
  // an SCL block goes to the text editor, which takes the tab's place
  const scl = file('FB_SclSections.s7dcl');
  await vscode.commands.executeCommand('vscode.open', scl);
  await until(() =>
    vscode.window.activeTextEditor?.document.uri.toString() === scl.toString() ? true : undefined,
  );
  await until(() =>
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some(
        (t) =>
          t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === scl.toString(),
      )
      ? undefined
      : true,
  );
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('the LAD/FBD view shows the block interface panel', async () => {
  const settings = vscode.workspace.getConfiguration('plcstudio');
  await settings.update('ladder.interfaceOpen', true, vscode.ConfigurationTarget.Global);
  try {
    await openWith('FC_LadContacts.s7dcl', 'plcstudio.ladderEditor');
    // the panel opens by itself, asks for the interface and reports its table as drawn
    const h = await until(async () => {
      const now = await health();
      return now.rendered.includes('plcstudio.ladderEditor#interface') || now.errors.length > 0
        ? now
        : undefined;
    });
    assert.deepEqual(h.errors, []);
  } finally {
    await settings.update('ladder.interfaceOpen', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
});

test('a table view refreshes when another file of its PLC changes', async () => {
  await openWith('FB_SclSections.s7dcl', 'plcstudio.translationTable');
  await rendered('plcstudio.translationTable');
  // let the first renders settle, then change only the .s7res next to the block
  await new Promise((r) => setTimeout(r, 1000));
  const before = (await health()).renders['plcstudio.translationTable'] ?? 0;
  const res = await vscode.workspace.openTextDocument(file('FB_SclSections.s7res'));
  const change = new vscode.WorkspaceEdit();
  change.insert(
    res.uri,
    new vscode.Position(res.lineCount, 0),
    '  - id: MLC_Refresh\r\n    en-US: x\r\n',
  );
  assert.ok(await vscode.workspace.applyEdit(change));
  await until(async () =>
    ((await health()).renders['plcstudio.translationTable'] ?? 0) > before ? true : undefined,
  );
  await vscode.window.showTextDocument(res);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('program graph renders', async () => {
  await vscode.commands.executeCommand('plcstudio.showProgramGraph');
  await rendered('plcstudio.programGraph');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('commands are registered', async () => {
  const commands = await vscode.commands.getCommands(true);
  for (const c of [
    'plcstudio.createManifest',
    'plcstudio.showProfileCoverage',
    'plcstudio.restartServer',
    'plcstudio.useForPlcFiles',
    'plcstudio.openLadderView',
    'plcstudio.openInterfaceEditor',
    'plcstudio.openDataBlockEditor',
    'plcstudio.openTranslationTable',
    'plcstudio.openTagTableEditor',
    'plcstudio.showProgramGraph',
    'plcstudio.traceValue',
    'plcstudio.refreshCallTree',
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
