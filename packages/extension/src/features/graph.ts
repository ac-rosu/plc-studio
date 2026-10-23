// Program graph (spec M12): the whole program of one PLC as a graph, in a webview panel with
// filters by OB, unit and instance. Built from the block index and the analysed call sites.
import * as vscode from 'vscode';
import { analyzeProject, type Project } from '@plcstudio/core';
import { viewHealthMessage } from '../webview/health.ts';
import { webviewHtml } from '../webview/html.ts';
import type { FeatureContext } from './index.ts';
import { workspaceModel, type PlcWorkspaceModel } from './tables-workspace.ts';

export interface GraphNode {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly namespace: string;
  readonly unit: string;
  readonly failsafe: boolean;
  readonly dbKind: string;
  readonly path: string;
  readonly obType: string;
  readonly priority: number | null;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'call' | 'instance' | 'instanceOf';
  readonly conditional: boolean;
  readonly inLoop: boolean;
  readonly count: number;
}

export interface GraphModel {
  readonly view: 'graph';
  readonly plcs: { root: string; name: string }[];
  readonly plc: string;
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

export function graphModel(project: Project, plcs: { root: string; name: string }[]): GraphModel {
  const index = project.index;
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (const b of index.blocks) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    const ob = b.kind === 'OB' ? index.obInfo(b) : undefined;
    nodes.push({
      id: b.id,
      name: b.namespace ? `${b.namespace}.${b.name}` : b.name,
      kind: b.kind,
      namespace: b.namespace ?? '',
      unit: b.unit?.name ?? '',
      failsafe: b.failsafe,
      dbKind: b.dbKind ?? '',
      path: b.file.path,
      obType: ob?.type ?? '',
      priority: ob?.priority ?? null,
    });
  }
  const edges = new Map<
    string,
    {
      from: string;
      to: string;
      kind: GraphEdge['kind'];
      conditional: boolean;
      inLoop: boolean;
      count: number;
    }
  >();
  const add = (
    from: string,
    to: string,
    kind: GraphEdge['kind'],
    conditional: boolean,
    inLoop: boolean,
  ) => {
    if (!seen.has(from) || !seen.has(to)) return;
    const key = `${from}>${to}>${kind}`;
    const e = edges.get(key);
    if (e) {
      e.count++;
      e.conditional ||= conditional;
      e.inLoop ||= inLoop;
    } else edges.set(key, { from, to, kind, conditional, inLoop, count: 1 });
  };
  for (const call of analyzeProject(project).calls) {
    if (call.calleeId?.startsWith('block:'))
      add(call.callerId, call.calleeId, 'call', call.conditional, call.inLoop);
    if (call.instance?.kind === 'single') {
      add(call.callerId, call.instance.id, 'instance', call.conditional, call.inLoop);
      if (call.calleeId) add(call.instance.id, call.calleeId, 'instanceOf', false, false);
    }
  }
  return { view: 'graph', plcs, plc: project.root, nodes, edges: [...edges.values()] };
}

function plcList(ws: PlcWorkspaceModel): { root: string; name: string }[] {
  return [...ws.workspace.projects.values()].map((p) => ({
    root: p.root,
    name: p.manifest?.name || p.root.slice(p.root.lastIndexOf('/') + 1),
  }));
}

export function registerGraph({ extension }: FeatureContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let root: string | undefined;
  const ws = workspaceModel(extension);
  const send = () => {
    if (!panel) return;
    const projects = [...ws.workspace.projects.values()];
    const project = projects.find((p) => p.root === root) ?? projects[0] ?? ws.workspace.loose;
    root = project.root;
    void panel.webview.postMessage({ type: 'update', model: graphModel(project, plcList(ws)) });
  };
  extension.subscriptions.push(
    ws.onDidChange(send),
    vscode.commands.registerCommand('plcstudio.showProgramGraph', async () => {
      await ws.ready;
      if (panel) {
        panel.reveal();
        send();
        return;
      }
      panel = vscode.window.createWebviewPanel(
        'plcstudio.programGraph',
        'Program graph',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(extension.extensionUri, 'dist', 'webviews')],
        },
      );
      panel.webview.html = webviewHtml(
        panel.webview,
        extension.extensionUri,
        'graph',
        'Program graph',
      );
      panel.onDidDispose(() => (panel = undefined));
      panel.webview.onDidReceiveMessage(async (m: { type: string; [key: string]: unknown }) => {
        if (viewHealthMessage('plcstudio.programGraph', m)) return;
        if (m.type === 'ready') send();
        else if (m.type === 'selectPlc' && typeof m['root'] === 'string') {
          root = m['root'];
          send();
        } else if (m.type === 'open' && typeof m['path'] === 'string') {
          await vscode.window.showTextDocument(ws.uriOf(m['path']), { preview: true });
        }
      });
    }),
  );
}
