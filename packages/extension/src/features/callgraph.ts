// Call tree and Trace value views in the PLC Studio sidebar (M6.5, M6.6). The language server
// computes both from the call graph in core; this file only shows them.
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  CALL_TREE,
  TRACE_VALUE,
  type CallTreeItem,
  type CallTreePlc,
  type TraceItem,
  type TraceResult,
} from '@plcstudio/language-server/protocol';
import type { FeatureContext } from './index.ts';

const KIND_ICON: Record<CallTreeItem['kind'], string> = {
  ob: 'symbol-event',
  fb: 'symbol-class',
  fc: 'symbol-method',
  instruction: 'symbol-operator',
  unresolved: 'question',
};

type CallNode = { plc: CallTreePlc } | { item: CallTreeItem };

class CallTreeProvider implements vscode.TreeDataProvider<CallNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private plcs: CallTreePlc[] = [];
  instructions = false;
  private readonly client: LanguageClient;

  constructor(client: LanguageClient) {
    this.client = client;
  }

  async refresh(): Promise<void> {
    this.plcs = await this.client
      .sendRequest<CallTreePlc[]>(CALL_TREE, { instructions: this.instructions })
      .catch(() => []);
    this.changed.fire();
  }

  getChildren(node?: CallNode): CallNode[] {
    if (!node) {
      // one PLC folder: show its OBs directly
      if (this.plcs.length === 1) return this.plcs[0]!.roots.map((item) => ({ item }));
      return this.plcs.map((plc) => ({ plc }));
    }
    if ('plc' in node) return node.plc.roots.map((item) => ({ item }));
    return node.item.children.map((item) => ({ item }));
  }

  getTreeItem(node: CallNode): vscode.TreeItem {
    if ('plc' in node) {
      const t = new vscode.TreeItem(node.plc.name, vscode.TreeItemCollapsibleState.Expanded);
      t.iconPath = new vscode.ThemeIcon('circuit-board');
      t.resourceUri = vscode.Uri.parse(node.plc.uri);
      return t;
    }
    const item = node.item;
    const t = new vscode.TreeItem(
      item.name,
      item.children.length > 0
        ? item.kind === 'ob'
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    t.description = item.detail;
    t.tooltip = `${item.kind.toUpperCase()} ${item.name}${item.detail ? `\n${item.detail}` : ''}`;
    t.iconPath = new vscode.ThemeIcon(item.recursive ? 'sync' : KIND_ICON[item.kind]);
    // the file decoration (fail-safe badge) applies through the resource
    t.resourceUri = vscode.Uri.parse(item.uri);
    t.command = {
      title: 'Open',
      // the text at the place, not the view a click in the explorer would choose
      command: 'vscode.openWith',
      arguments: [
        vscode.Uri.parse(item.uri),
        'default',
        { selection: toRange(item.range), preview: true } satisfies vscode.TextDocumentShowOptions,
      ],
    };
    return t;
  }
}

class TraceProvider implements vscode.TreeDataProvider<TraceItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  result: TraceResult | undefined;

  show(result: TraceResult | undefined): void {
    this.result = result;
    this.changed.fire();
  }

  getChildren(node?: TraceItem): TraceItem[] {
    return node ? [] : (this.result?.items ?? []);
  }

  getTreeItem(item: TraceItem): vscode.TreeItem {
    const t = new vscode.TreeItem(item.line || item.blockName);
    t.description = `${item.access} · ${item.blockName}${item.via.length > 0 ? ` · via ${item.via.join(' → ')}` : ''}`;
    t.tooltip = `${item.access} in ${item.blockName}, line ${item.range.start.line + 1}`;
    t.iconPath = new vscode.ThemeIcon(
      item.access === 'write'
        ? 'edit'
        : item.access === 'readwrite'
          ? 'arrow-swap'
          : item.access === 'call'
            ? 'call-outgoing'
            : 'eye',
    );
    t.command = {
      title: 'Open',
      // the text at the place, not the view a click in the explorer would choose
      command: 'vscode.openWith',
      arguments: [
        vscode.Uri.parse(item.uri),
        'default',
        { selection: toRange(item.range), preview: true } satisfies vscode.TextDocumentShowOptions,
      ],
    };
    return t;
  }
}

function toRange(r: TraceItem['range']): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

export function registerCallGraph({ extension, client }: FeatureContext): void {
  const calls = new CallTreeProvider(client);
  const trace = new TraceProvider();
  const callView = vscode.window.createTreeView('plcstudio.callTree', {
    treeDataProvider: calls,
    showCollapseAll: true,
  });
  const traceView = vscode.window.createTreeView('plcstudio.trace', { treeDataProvider: trace });

  // refresh the call tree a little after edits and file changes, and only while it is visible
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = () => {
    if (!callView.visible) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void calls.refresh(), 1000);
  };
  const isPlcDocument = (doc: vscode.TextDocument) => doc.languageId.startsWith('plcstudio-');

  extension.subscriptions.push(
    callView,
    traceView,
    callView.onDidChangeVisibility((e) => {
      if (e.visible) void calls.refresh();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isPlcDocument(e.document)) refreshSoon();
    }),
    vscode.workspace.onDidSaveTextDocument(() => refreshSoon()),
    vscode.workspace.onDidCreateFiles(() => refreshSoon()),
    vscode.workspace.onDidDeleteFiles(() => refreshSoon()),
    vscode.commands.registerCommand('plcstudio.refreshCallTree', () => calls.refresh()),
    vscode.commands.registerCommand('plcstudio.toggleCallTreeInstructions', async () => {
      calls.instructions = !calls.instructions;
      await calls.refresh();
    }),
    vscode.commands.registerCommand(
      'plcstudio.traceValue',
      async (uri?: vscode.Uri, position?: vscode.Position) => {
        const editor = vscode.window.activeTextEditor;
        const target = uri ?? editor?.document.uri;
        const at = position ?? editor?.selection.active;
        if (!target || !at) return;
        const result = await client
          .sendRequest<TraceResult | null>(TRACE_VALUE, {
            uri: target.toString(),
            position: { line: at.line, character: at.character },
          })
          .catch(() => null);
        if (!result) {
          void vscode.window.showInformationMessage(
            'PLC Studio: place the cursor on a variable, tag or data block member to trace it.',
          );
          return;
        }
        trace.show(result);
        traceView.title = `Trace: ${result.name}`;
        traceView.message =
          result.items.length === 0
            ? `${result.name} is not read or written anywhere.`
            : `${result.items.length} use${result.items.length === 1 ? '' : 's'} of ${result.name}, across blocks`;
        await vscode.commands.executeCommand('plcstudio.trace.focus');
      },
    ),
    vscode.commands.registerCommand('plcstudio.clearTrace', () => {
      trace.show(undefined);
      traceView.title = 'Trace value';
      traceView.message = '';
    }),
  );
}
