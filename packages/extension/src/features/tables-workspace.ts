// The project data the table editors, the program graph and the fail-safe marking need: a core
// Workspace built from the workspace files and kept current (open documents win over the disk).
// Kept in this one module so it can later be replaced by data from the language server.
import * as vscode from 'vscode';
import { normalizePath, SourceText, Workspace, type Project, type TextEdit } from '@plcstudio/core';

const GLOB = '**/{*.s7dcl,*.s7res,*.scl,*.udt,*.db,*.xml,plc.json}';
const EXCLUDE = '{**/node_modules/**,**/.git/**,**/.vscode-test/**,**/dist/**}';

export class PlcWorkspaceModel implements vscode.Disposable {
  readonly workspace = new Workspace();
  readonly ready: Promise<void>;
  private readonly uris = new Map<string, vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<readonly string[]>();
  /** Fires after files changed (debounced), with the paths that changed. */
  readonly onDidChange = this.changed.event;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Set<string>();

  constructor() {
    this.ready = this.scan();
    const watcher = vscode.workspace.createFileSystemWatcher(GLOB);
    this.disposables.push(
      watcher,
      watcher.onDidCreate((u) => void this.load(u)),
      watcher.onDidChange((u) => {
        if (
          !vscode.workspace.textDocuments.some(
            (d) => d.uri.toString() === u.toString() && d.isDirty,
          )
        )
          void this.load(u);
      }),
      watcher.onDidDelete((u) => {
        const path = this.pathOf(u);
        this.workspace.removeFile(path);
        this.fire(path);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file' || !isPlcPath(e.document.uri.path)) return;
        const path = this.pathOf(e.document.uri);
        this.workspace.setFileText(path, e.document.getText());
        this.fire(path);
      }),
      this.changed,
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private fire(path?: string): void {
    if (path) this.pending.add(path);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const paths = [...this.pending];
      this.pending.clear();
      this.changed.fire(paths);
    }, 150);
  }

  /**
   * Whether a change of `paths` can alter what a view of `document` shows: another file of the same
   * PLC folder (a UDT or FB it uses, its .s7res, the manifest). The document itself is left out;
   * its own view refreshes on its own changes.
   */
  affects(document: vscode.TextDocument, paths: readonly string[]): boolean {
    const own = this.pathOf(document.uri).toLowerCase();
    const root = this.workspace.projectFor(this.pathOf(document.uri)).root;
    return paths.some((p) => p.toLowerCase() !== own && this.workspace.projectFor(p).root === root);
  }

  pathOf(uri: vscode.Uri): string {
    const p = normalizePath(uri.fsPath);
    this.uris.set(p.toLowerCase(), uri);
    return p;
  }

  uriOf(path: string): vscode.Uri {
    return this.uris.get(path.toLowerCase()) ?? vscode.Uri.file(path);
  }

  private async scan(): Promise<void> {
    const uris = await vscode.workspace.findFiles(GLOB, EXCLUDE, 20000);
    // manifests first, so files land in their PLC folder
    uris.sort(
      (a, b) => Number(!a.path.endsWith('plc.json')) - Number(!b.path.endsWith('plc.json')),
    );
    for (const u of uris) await this.load(u, false);
    this.fire();
  }

  private async load(uri: vscode.Uri, notify = true): Promise<void> {
    try {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const path = this.pathOf(uri);
      if (open) this.workspace.setFileText(path, open.getText());
      else
        this.workspace.setFileSource(
          path,
          SourceText.fromBytes(await vscode.workspace.fs.readFile(uri)),
        );
      if (notify) this.fire(path);
    } catch {
      // unreadable files are skipped
    }
  }

  /** The project of a document, with the document's current text. */
  projectFor(document: vscode.TextDocument): Project {
    const path = this.pathOf(document.uri);
    const project = this.workspace.projectFor(path);
    const current = project.files.get(path);
    if (!current || current.source.text !== document.getText())
      this.workspace.setFileText(path, document.getText());
    return this.workspace.projectFor(path);
  }

  /** Display language: setting, then plc.json, then the first language found, then en-US. */
  displayLanguage(project: Project, available: readonly string[] = []): string {
    const setting = vscode.workspace.getConfiguration('plcstudio').get<string>('displayLanguage');
    return setting || project.manifest?.displayLanguage || available[0] || 'en-US';
  }

  /** Every culture used by a project's .s7res files and tag tables. */
  cultures(project: Project): string[] {
    const set = new Set<string>();
    for (const f of project.files.values()) {
      if (f.parsed?.kind === 'resources')
        for (const e of f.parsed.entries) for (const v of e.values) set.add(v.culture);
      if (f.parsed?.kind === 'tagTable')
        for (const e of f.parsed.entries) for (const c of e.comments.keys()) set.add(c);
    }
    if (project.manifest?.displayLanguage) set.add(project.manifest.displayLanguage);
    return [...set].sort();
  }
}

export function isPlcPath(path: string): boolean {
  return /\.(s7dcl|s7res|scl|udt|db|xml)$/i.test(path) || /plc\.json$/i.test(path);
}

let model: PlcWorkspaceModel | undefined;

export function workspaceModel(context: vscode.ExtensionContext): PlcWorkspaceModel {
  if (!model) {
    model = new PlcWorkspaceModel();
    context.subscriptions.push(model);
  }
  return model;
}

/** Adds core text edits for a file (open or not) to a WorkspaceEdit. */
export async function addFileEdits(
  edit: vscode.WorkspaceEdit,
  uri: vscode.Uri,
  edits: readonly TextEdit[],
): Promise<void> {
  if (edits.length === 0) return;
  const document = await vscode.workspace.openTextDocument(uri);
  for (const e of edits)
    edit.replace(
      uri,
      new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)),
      e.newText,
    );
}
