// The language server, shared by the Node and the browser entry points. It sees only an LSP
// connection; files are read through the client (custom requests), so the same code runs in a
// browser worker (ADR 0006). Everything else comes from core.
import {
  analyzeProject,
  calledFrom,
  callHierarchyAt,
  callTree,
  codeLenses,
  completionsAt,
  definitionOf,
  foldingRanges,
  formatDocument,
  formatRanges,
  hoverAt,
  incomingCalls,
  inlayHints,
  normalizePath,
  outgoingCalls,
  outline,
  pickText,
  quickFixes,
  referenceAt,
  referencesOf,
  renameEdits,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
  semanticTokens,
  signatureHelpAt,
  SourceText,
  traceValue,
  workspaceSymbols,
  Workspace,
  type CallTreeNode,
  type CompletionKind,
  type OutlineItem,
  type OutlineKind,
  type Project,
  type SyntaxDiagnostic,
  type TextEdit as CoreEdit,
} from '@plcstudio/core';
import {
  CodeActionKind,
  CompletionItemKind,
  DiagnosticSeverity,
  FileChangeType,
  FoldingRangeKind,
  InsertTextFormat,
  MarkupKind,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  type CallHierarchyItem,
  type Connection,
  type Diagnostic,
  type DocumentSymbol,
  type Location,
  type Range as LspRange,
  type ServerCapabilities,
  type TextDocumentEdit,
  type WorkspaceEdit,
  RenameFile,
  OptionalVersionedTextDocumentIdentifier,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI, Utils } from 'vscode-uri';

import {
  CALL_TREE,
  READ_DIRECTORY,
  READ_FILE,
  TRACE_VALUE,
  type CallTreeItem,
  type CallTreePlc,
  type TraceItem,
  type TraceResult,
} from './protocol.ts';

export * from './protocol.ts';

export function serverCapabilities(): ServerCapabilities {
  return {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: { triggerCharacters: ['#', '"', '.', '(', ','], resolveProvider: false },
    hoverProvider: true,
    signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
    definitionProvider: true,
    referencesProvider: true,
    renameProvider: { prepareProvider: true },
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    foldingRangeProvider: true,
    semanticTokensProvider: {
      legend: {
        tokenTypes: [...SEMANTIC_TOKEN_TYPES],
        tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
      },
      full: true,
    },
    inlayHintProvider: true,
    codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
    codeLensProvider: { resolveProvider: false },
    callHierarchyProvider: true,
    documentFormattingProvider: true,
    documentRangeFormattingProvider: { rangesSupport: true },
  };
}

const COMPLETION_KIND: Record<CompletionKind, CompletionItemKind> = {
  variable: CompletionItemKind.Variable,
  field: CompletionItemKind.Field,
  function: CompletionItemKind.Function,
  module: CompletionItemKind.Module,
  class: CompletionItemKind.Class,
  struct: CompletionItemKind.Struct,
  keyword: CompletionItemKind.Keyword,
  constant: CompletionItemKind.Constant,
  snippet: CompletionItemKind.Snippet,
  property: CompletionItemKind.Property,
  enumMember: CompletionItemKind.EnumMember,
};

const SYMBOL_KIND: Record<OutlineKind, SymbolKind> = {
  module: SymbolKind.Module,
  class: SymbolKind.Class,
  function: SymbolKind.Function,
  struct: SymbolKind.Struct,
  object: SymbolKind.Object,
  namespace: SymbolKind.Namespace,
  field: SymbolKind.Field,
  variable: SymbolKind.Variable,
  constant: SymbolKind.Constant,
  event: SymbolKind.Event,
  property: SymbolKind.Property,
};

export interface ServerOptions {
  /** Debounce before re-analysing after typing (spec: diagnostics within 200 ms). */
  debounceMs?: number;
}

export function startServer(connection: Connection, options: ServerOptions = {}): PlcStudioServer {
  const server = new PlcStudioServer(connection, options);
  server.listen();
  return server;
}

export class PlcStudioServer {
  readonly connection: Connection;
  readonly documents = new TextDocuments(TextDocument);
  readonly workspace = new Workspace();
  private readonly uris = new Map<string, string>();
  private readonly published = new Map<string, string>();
  private readonly timers = new Map<Project, ReturnType<typeof setTimeout>>();
  private workspaceFolders: string[] = [];
  private displayLanguageSetting: string | undefined;
  private readonly debounceMs: number;
  /** Resolves when the first workspace scan is done. */
  ready: Promise<void> = Promise.resolve();

  constructor(connection: Connection, options: ServerOptions) {
    this.connection = connection;
    this.debounceMs = options.debounceMs ?? 120;
    // where an FB or FC runs, from the call graph (M6.7)
    const runsIn = (project: Project, id: string) => {
      const kind = project.index.block(id)?.kind;
      return project.hasManifest && (kind === 'FB' || kind === 'FC')
        ? calledFrom(project, id)
        : undefined;
    };
    this.hoverExtra = (project, id) => {
      const summary = runsIn(project, id);
      return summary ? `Called from: ${summary}` : undefined;
    };
    this.codeLensExtra = (project, id) => {
      const summary = runsIn(project, id);
      return summary ? `called from ${summary}` : undefined;
    };
  }

  // --- Paths ---------------------------------------------------------------------------------

  pathOf(uri: string): string {
    const path = normalizePath(URI.parse(uri).path);
    this.uris.set(path.toLowerCase(), uri);
    return path;
  }

  uriOf(path: string): string {
    return this.uris.get(path.toLowerCase()) ?? URI.file(path).toString();
  }

  private sourceOf(project: Project, path: string): SourceText | undefined {
    if (project.manifestPath && path.toLowerCase() === project.manifestPath.toLowerCase()) {
      return new SourceText(project.manifestText ?? '');
    }
    if (project.rulesPath && path.toLowerCase() === project.rulesPath.toLowerCase()) {
      return new SourceText(project.rulesText ?? '');
    }
    return project.files.get(path)?.source;
  }

  private range(source: SourceText, start: number, end: number): LspRange {
    return { start: source.positionAt(start), end: source.positionAt(end) };
  }

  displayLanguage(project: Project): string | undefined {
    return this.displayLanguageSetting || project.manifest?.displayLanguage;
  }

  // --- Lifecycle -----------------------------------------------------------------------------

  listen(): void {
    const c = this.connection;
    c.onInitialize((params) => {
      this.workspaceFolders = (params.workspaceFolders ?? []).map((f) => f.uri);
      if (this.workspaceFolders.length === 0 && params.rootUri)
        this.workspaceFolders = [params.rootUri];
      return { capabilities: serverCapabilities(), serverInfo: { name: 'PLC Studio' } };
    });
    c.onInitialized(() => {
      this.ready = this.scan();
    });
    c.onDidChangeConfiguration(() => void this.loadSettings());
    this.documents.onDidChangeContent((e) => {
      const path = this.pathOf(e.document.uri);
      this.workspace.setFileText(path, e.document.getText());
      this.schedule(this.workspace.projectFor(path));
    });
    c.onDidChangeWatchedFiles(async (e) => {
      const touched = new Set<Project>();
      for (const change of e.changes) {
        const path = this.pathOf(change.uri);
        // a workspace-level rules file applies to every PLC folder below it
        if (path.toLowerCase().endsWith('/plcstudio.rules.json'))
          for (const p of this.workspace.allProjects()) touched.add(p);
        if (change.type === FileChangeType.Deleted) {
          touched.add(this.workspace.projectFor(path));
          this.workspace.removeFile(path);
          this.connection.sendDiagnostics({ uri: change.uri, diagnostics: [] });
          this.published.delete(change.uri);
        } else if (!this.documents.get(change.uri)) {
          const bytes = await this.readFile(change.uri);
          if (bytes) this.workspace.setFileSource(path, SourceText.fromBytes(bytes));
        }
        touched.add(this.workspace.projectFor(path));
      }
      for (const p of touched) this.schedule(p, 0);
    });
    this.registerFeatures();
    this.documents.listen(c);
    c.listen();
  }

  private async loadSettings(): Promise<void> {
    try {
      const settings = (await this.connection.workspace.getConfiguration('plcstudio')) as {
        displayLanguage?: string;
      } | null;
      this.displayLanguageSetting = settings?.displayLanguage || undefined;
    } catch {
      this.displayLanguageSetting = undefined;
    }
  }

  async readFile(uri: string): Promise<Uint8Array | undefined> {
    try {
      const base64 = (await this.connection.sendRequest(READ_FILE, { uri })) as string | null;
      if (base64 === null) return undefined;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      return undefined;
    }
  }

  private async scan(): Promise<void> {
    await this.loadSettings();
    await this.workspace.scan(
      {
        readFile: async (path) => {
          const bytes = await this.readFile(this.uriOf(path));
          if (!bytes) throw new Error(`cannot read ${path}`);
          return bytes;
        },
        readDirectory: async (path) => {
          const uri = this.uriOf(path);
          const entries = (await this.connection.sendRequest(READ_DIRECTORY, { uri })) as
            [string, boolean][] | null;
          for (const [name] of entries ?? []) {
            const child = Utils.joinPath(URI.parse(uri), name).toString();
            this.uris.set(normalizePath(`${path}/${name}`).toLowerCase(), child);
          }
          return entries ?? [];
        },
      },
      this.workspaceFolders.map((uri) => this.pathOf(uri)),
    );
    // open documents win over what is on disk
    for (const doc of this.documents.all())
      this.workspace.setFileText(this.pathOf(doc.uri), doc.getText());
    for (const p of this.workspace.allProjects()) this.publish(p);
  }

  schedule(project: Project, delay = this.debounceMs): void {
    const old = this.timers.get(project);
    if (old) clearTimeout(old);
    this.timers.set(
      project,
      setTimeout(() => {
        this.timers.delete(project);
        this.publish(project);
      }, delay),
    );
  }

  /** Diagnostics of every file of a project; only changed lists are sent. */
  publish(project: Project): void {
    const analysis = analyzeProject(project);
    const paths = new Set<string>([
      ...project.files.keys(),
      ...(project.manifestPath ? [project.manifestPath] : []),
      ...(project.rulesPath ? [project.rulesPath] : []),
    ]);
    for (const path of paths) {
      const source = this.sourceOf(project, path);
      if (!source) continue;
      const list = analysis.diagnostics.get(path) ?? [];
      const diagnostics = list.map((d) => this.toDiagnostic(source, d));
      const uri = this.uriOf(path);
      const key = JSON.stringify(diagnostics);
      if (this.published.get(uri) === key) continue;
      this.published.set(uri, key);
      this.connection.sendDiagnostics({ uri, diagnostics });
    }
  }

  private toDiagnostic(source: SourceText, d: SyntaxDiagnostic): Diagnostic {
    return {
      range: this.range(source, d.range.start, d.range.end),
      severity:
        d.severity === 'error'
          ? DiagnosticSeverity.Error
          : d.severity === 'warning'
            ? DiagnosticSeverity.Warning
            : DiagnosticSeverity.Information,
      code: d.code,
      source: 'PLC Studio',
      message: d.message,
    };
  }

  /** Project, path and offset of a position in an open or known file. */
  locate(
    uri: string,
    position: { line: number; character: number },
  ): { project: Project; path: string; offset: number; source: SourceText } | undefined {
    const path = this.pathOf(uri);
    const project = this.workspace.projectFor(path);
    const source = project.files.get(path)?.source;
    if (!source) return undefined;
    return { project, path, offset: source.offsetAt(position), source };
  }

  private location(
    project: Project,
    file: string,
    start: number,
    end: number,
  ): Location | undefined {
    const source = this.sourceOf(project, file);
    return source ? { uri: this.uriOf(file), range: this.range(source, start, end) } : undefined;
  }

  private workspaceEdit(
    project: Project,
    edits: ReadonlyMap<string, readonly CoreEdit[]>,
    renames: readonly { from: string; to: string }[] = [],
  ): WorkspaceEdit {
    const documentChanges: (TextDocumentEdit | RenameFile)[] = [];
    for (const [file, list] of edits) {
      const source = this.sourceOf(project, file);
      if (!source) continue;
      documentChanges.push({
        textDocument: OptionalVersionedTextDocumentIdentifier.create(this.uriOf(file), null),
        edits: list.map((e) => ({ range: this.range(source, e.start, e.end), newText: e.newText })),
      });
    }
    for (const r of renames) {
      const to = Utils.joinPath(
        Utils.dirname(URI.parse(this.uriOf(r.from))),
        r.to.slice(r.to.lastIndexOf('/') + 1),
      ).toString();
      documentChanges.push(RenameFile.create(this.uriOf(r.from), to));
    }
    return { documentChanges };
  }

  // --- Call graph views ----------------------------------------------------------------------

  /** The call tree of every PLC folder with a manifest (M6.6). */
  callTrees(instructions = false): CallTreePlc[] {
    const describe = (n: CallTreeNode): string => {
      if (n.kind === 'ob') return '';
      const parts: string[] = [];
      if (n.instance) parts.push(n.instance);
      parts.push(
        n.conditional ? (n.condition ? `if ${n.condition}` : 'conditional') : 'every call',
      );
      if (n.inLoop) parts.push('in a loop');
      if (n.viaEn) parts.push('via EN');
      if (n.recursive) parts.push('recursive');
      return parts.join(' · ');
    };
    const convert = (project: Project, n: CallTreeNode): CallTreeItem | undefined => {
      const source = this.sourceOf(project, n.file);
      if (!source) return undefined;
      return {
        name: n.name,
        kind: n.kind,
        detail: describe(n),
        uri: this.uriOf(n.file),
        range: this.range(source, n.start, n.end),
        recursive: n.recursive,
        children: n.children.flatMap((child) => convert(project, child) ?? []),
      };
    };
    return this.workspace
      .allProjects()
      .filter((p) => p.hasManifest)
      .map((project) => ({
        name: project.manifest?.name || project.root.slice(project.root.lastIndexOf('/') + 1),
        uri: this.uriOf(project.root),
        roots: callTree(project, { instructions }).flatMap((n) => convert(project, n) ?? []),
      }));
  }

  /** Every read and write of the symbol at a position, across blocks (M6.5). */
  trace(uri: string, position: { line: number; character: number }): TraceResult | null {
    const at = this.locate(uri, position);
    if (!at) return null;
    const ref = referenceAt(at.project, at.path, at.offset);
    if (!ref || ref.symbolKind === 'instruction') return null;
    const name = at.source.text.slice(ref.range.start, ref.range.end);
    const items = traceValue(at.project, ref.symbolId)
      .filter((e) => e.access !== 'declaration' && e.access !== 'type')
      .flatMap((e): TraceItem[] => {
        const source = this.sourceOf(at.project, e.file);
        if (!source) return [];
        const range = this.range(source, e.range.start, e.range.end);
        const lineStart = source.offsetAt({ line: range.start.line, character: 0 });
        const lineEnd = source.offsetAt({ line: range.start.line + 1, character: 0 });
        return [
          {
            uri: this.uriOf(e.file),
            range,
            access: e.access,
            blockName: e.blockName,
            via: [...e.via],
            line: source.text.slice(lineStart, lineEnd).trim(),
          },
        ];
      });
    return { name, items };
  }

  // --- Features ------------------------------------------------------------------------------

  private registerFeatures(): void {
    const c = this.connection;

    c.onRequest(CALL_TREE, (params: { instructions?: boolean } | null) =>
      this.callTrees(params?.instructions ?? false),
    );
    c.onRequest(
      TRACE_VALUE,
      (params: { uri: string; position: { line: number; character: number } }) =>
        this.trace(params.uri, params.position),
    );

    const formatEdits = (uri: string, lines?: { start: number; end: number }[]) => {
      const path = this.pathOf(uri);
      const project = this.workspace.projectFor(path);
      const file = project.files.get(path);
      if (!file || file.parsed?.kind !== 'blocks') return [];
      const text = file.source.text;
      const options = project.rules.format;
      const edits = lines
        ? formatRanges(path, text, lines, options)
        : formatDocument(path, text, options);
      return edits.map((e) => ({
        range: this.range(file.source, e.start, e.end),
        newText: e.newText,
      }));
    };
    // a range that ends at column 0 of a line does not include that line
    const lineRange = (r: LspRange) => ({
      start: r.start.line,
      end: r.end.character === 0 && r.end.line > r.start.line ? r.end.line - 1 : r.end.line,
    });
    c.onDocumentFormatting((params) => formatEdits(params.textDocument.uri));
    c.onDocumentRangeFormatting((params) =>
      formatEdits(params.textDocument.uri, [lineRange(params.range)]),
    );
    c.onDocumentRangesFormatting((params) =>
      formatEdits(params.textDocument.uri, params.ranges.map(lineRange)),
    );

    c.onRequest('plcstudio/instructionUsage', () => {
      const counts = new Map<string, { name: string; known: boolean; count: number }>();
      for (const project of this.workspace.allProjects()) {
        for (const call of analyzeProject(project).calls) {
          if (call.kind !== 'instruction') continue;
          const name = call.calleeName.toUpperCase();
          const known =
            !!project.profile.instruction(name) ||
            !!project.profile.conversion(name) ||
            !!project.profile.systemType(name);
          const entry = counts.get(name) ?? { name, known, count: 0 };
          entry.count++;
          counts.set(name, entry);
        }
      }
      return [...counts.values()];
    });

    c.onCompletion((params) => {
      const at = this.locate(params.textDocument.uri, params.position);
      if (!at) return [];
      return completionsAt(at.project, at.path, at.offset, this.displayLanguage(at.project)).map(
        (e) => {
          const start = at.offset - (e.replaceLength ?? 0);
          const range = this.range(at.source, start, at.offset);
          return {
            label: e.label,
            kind: COMPLETION_KIND[e.kind],
            ...(e.detail ? { detail: e.detail } : {}),
            ...(e.documentation
              ? { documentation: { kind: MarkupKind.Markdown, value: e.documentation } }
              : {}),
            ...(e.sortText ? { sortText: e.sortText } : {}),
            insertTextFormat: e.snippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
            textEdit: { range, newText: e.insertText ?? e.label },
          };
        },
      );
    });

    c.onHover((params) => {
      const at = this.locate(params.textDocument.uri, params.position);
      if (!at) return null;
      const hover = hoverAt(
        at.project,
        at.path,
        at.offset,
        this.displayLanguage(at.project),
        (id) => this.hoverExtra?.(at.project, id),
      );
      return hover
        ? {
            contents: { kind: MarkupKind.Markdown, value: hover.contents },
            range: this.range(at.source, hover.range.start, hover.range.end),
          }
        : null;
    });

    c.onSignatureHelp((params) => {
      const at = this.locate(params.textDocument.uri, params.position);
      if (!at) return null;
      const help = signatureHelpAt(
        at.project,
        at.path,
        at.offset,
        this.displayLanguage(at.project),
      );
      if (!help) return null;
      return {
        signatures: [
          {
            label: help.signature.label,
            ...(help.signature.documentation
              ? { documentation: help.signature.documentation }
              : {}),
            parameters: help.signature.parameters.map((p) => ({
              label: p.label,
              ...(p.documentation ? { documentation: p.documentation } : {}),
            })),
          },
        ],
        activeSignature: 0,
        activeParameter: help.activeParameter,
      };
    });

    c.onDefinition((params) => {
      const at = this.locate(params.textDocument.uri, params.position);
      if (!at) return null;
      const ref = referenceAt(at.project, at.path, at.offset);
      const def = ref ? definitionOf(at.project, ref.symbolId) : undefined;
      return def
        ? (this.location(at.project, def.file, def.range.start, def.range.end) ?? null)
        : null;
    });

    c.onReferences((params) => {
      const at = this.locate(params.textDocument.uri, params.position);
      if (!at) return [];
      const ref = referenceAt(at.project, at.path, at.offset);
      if (!ref) return [];
      return referencesOf(at.project, ref.symbolId)
        .filter((r) => params.context.includeDeclaration || r.access !== 'declaration')
        .flatMap((r) => this.location(at.project, r.file, r.range.start, r.range.end) ?? []);
    });

    c.onPrepareRename((params) => {
      const at = this.locate(params.textDocument.uri, params.position);
      if (!at) return null;
      const ref = referenceAt(at.project, at.path, at.offset);
      if (!ref || ref.symbolKind === 'instruction') return null;
      const text = at.source.text.slice(ref.range.start, ref.range.end).replace(/^"|"$/g, '');
      return { range: this.range(at.source, ref.range.start, ref.range.end), placeholder: text };
    });

    c.onRenameRequest((params) => {
      const at = this.locate(params.textDocument.uri, params.position);
      if (!at) return null;
      const ref = referenceAt(at.project, at.path, at.offset);
      if (!ref) return null;
      const result = renameEdits(at.project, ref.symbolId, params.newName);
      if ('error' in result) throw new Error(result.error);
      return this.workspaceEdit(at.project, result.edits, result.fileRenames);
    });

    c.onDocumentSymbol((params) => {
      const path = this.pathOf(params.textDocument.uri);
      const project = this.workspace.projectFor(path);
      const file = project.files.get(path);
      if (file?.parsed?.kind !== 'blocks') return [];
      const res = project.index.resourcesFor(file);
      const language = this.displayLanguage(project);
      const titles = (n: { titleId: string | undefined }) => {
        const entry = n.titleId ? res?.entries.find((e) => e.id === n.titleId) : undefined;
        return entry
          ? pickText(new Map(entry.values.map((v) => [v.culture, v.text])), language)
          : undefined;
      };
      const convert = (item: OutlineItem): DocumentSymbol => ({
        name: item.name || '(unnamed)',
        detail: item.detail,
        kind: SYMBOL_KIND[item.kind],
        range: this.range(file.source, item.range.start, item.range.end),
        selectionRange: this.range(file.source, item.selectionRange.start, item.selectionRange.end),
        children: item.children.map(convert),
      });
      return outline(file.parsed, titles).map(convert);
    });

    c.onWorkspaceSymbol((params) =>
      this.workspace.allProjects().flatMap((project) =>
        workspaceSymbols(project, params.query).flatMap((s) => {
          const location = this.location(project, s.file, s.range.start, s.range.end);
          return location
            ? [
                {
                  name: s.name,
                  kind: SYMBOL_KIND[s.kind],
                  location,
                  ...(s.container ? { containerName: s.container } : {}),
                },
              ]
            : [];
        }),
      ),
    );

    c.onFoldingRanges((params) => {
      const path = this.pathOf(params.textDocument.uri);
      const file = this.workspace.projectFor(path).files.get(path);
      if (file?.parsed?.kind !== 'blocks') return [];
      return foldingRanges(file.parsed)
        .map((f) => ({
          startLine: file.source.positionAt(f.start).line,
          endLine: file.source.positionAt(f.end).line,
          ...(f.kind
            ? { kind: f.kind === 'region' ? FoldingRangeKind.Region : FoldingRangeKind.Comment }
            : {}),
        }))
        .filter((f) => f.endLine > f.startLine);
    });

    c.languages.semanticTokens.on((params) => {
      const path = this.pathOf(params.textDocument.uri);
      const project = this.workspace.projectFor(path);
      const source = project.files.get(path)?.source;
      if (!source) return { data: [] };
      const data: number[] = [];
      let prevLine = 0;
      let prevChar = 0;
      for (const t of semanticTokens(project, path)) {
        const pos = source.positionAt(t.start);
        const end = source.positionAt(t.start + t.length);
        if (end.line !== pos.line) continue;
        const deltaLine = pos.line - prevLine;
        const deltaChar = deltaLine === 0 ? pos.character - prevChar : pos.character;
        const mods = t.modifiers.reduce(
          (m, x) => m | (1 << SEMANTIC_TOKEN_MODIFIERS.indexOf(x)),
          0,
        );
        data.push(deltaLine, deltaChar, t.length, SEMANTIC_TOKEN_TYPES.indexOf(t.type), mods);
        prevLine = pos.line;
        prevChar = pos.character;
      }
      return { data };
    });

    c.languages.inlayHint.on((params) => {
      const path = this.pathOf(params.textDocument.uri);
      const project = this.workspace.projectFor(path);
      const source = project.files.get(path)?.source;
      if (!source) return [];
      const start = source.offsetAt(params.range.start);
      const end = source.offsetAt(params.range.end);
      return inlayHints(project, path, start, end, this.displayLanguage(project)).map((h) => ({
        position: source.positionAt(h.offset),
        label: h.label,
        paddingRight: true,
      }));
    });

    c.onCodeAction((params) => {
      const path = this.pathOf(params.textDocument.uri);
      const project = this.workspace.projectFor(path);
      const source = project.files.get(path)?.source;
      if (!source) return [];
      return params.context.diagnostics.flatMap((d) => {
        if (typeof d.code !== 'string') return [];
        const fixes = quickFixes(project, path, {
          code: d.code,
          message: typeof d.message === 'string' ? d.message : d.message.value,
          range: { start: source.offsetAt(d.range.start), end: source.offsetAt(d.range.end) },
        });
        return fixes.map((f) => ({
          title: f.title,
          kind: CodeActionKind.QuickFix,
          diagnostics: [d],
          ...(f.preferred ? { isPreferred: true } : {}),
          edit: this.workspaceEdit(project, f.edits),
        }));
      });
    });

    c.onCodeLens((params) => {
      const path = this.pathOf(params.textDocument.uri);
      const project = this.workspace.projectFor(path);
      const source = project.files.get(path)?.source;
      if (!source || !project.hasManifest) return [];
      return codeLenses(project, path, (b) => this.codeLensExtra?.(project, b.id)).map((l) => ({
        range: this.range(source, l.range.start, l.range.end),
        command: {
          title: l.title,
          command: 'plcstudio.showReferences',
          arguments: [params.textDocument.uri, source.positionAt(l.range.start)],
        },
      }));
    });

    c.languages.callHierarchy.onPrepare((params) => {
      const at = this.locate(params.textDocument.uri, params.position);
      if (!at) return null;
      const node = callHierarchyAt(at.project, at.path, at.offset);
      return node ? [this.hierarchyItem(at.project, node)] : null;
    });
    c.languages.callHierarchy.onIncomingCalls((params) => {
      const project = this.workspace.projectFor(this.pathOf(params.item.uri));
      const id = (params.item.data as { id: string }).id;
      return incomingCalls(project, id).map((call) => ({
        from: this.hierarchyItem(project, call.from),
        fromRanges: call.ranges.map((r) =>
          this.range(this.sourceOf(project, call.from.file)!, r.start, r.end),
        ),
      }));
    });
    c.languages.callHierarchy.onOutgoingCalls((params) => {
      const project = this.workspace.projectFor(this.pathOf(params.item.uri));
      const id = (params.item.data as { id: string }).id;
      const callerFile = this.pathOf(params.item.uri);
      return outgoingCalls(project, id).map((call) => ({
        to: this.hierarchyItem(project, call.to),
        fromRanges: call.ranges.map((r) =>
          this.range(this.sourceOf(project, callerFile)!, r.start, r.end),
        ),
      }));
    });
  }

  private hierarchyItem(
    project: Project,
    node: {
      id: string;
      name: string;
      kind: string;
      file: string;
      range: { start: number; end: number };
      selectionRange: { start: number; end: number };
    },
  ): CallHierarchyItem {
    const source = this.sourceOf(project, node.file)!;
    return {
      name: node.name,
      kind:
        node.kind === 'FC'
          ? SymbolKind.Function
          : node.kind === 'OB'
            ? SymbolKind.Module
            : SymbolKind.Class,
      detail: node.kind,
      uri: this.uriOf(node.file),
      range: this.range(source, node.range.start, node.range.end),
      selectionRange: this.range(source, node.selectionRange.start, node.selectionRange.end),
      data: { id: node.id },
    };
  }

  /** Extra hover text per symbol (call-graph summaries, added by later features). */
  hoverExtra: ((project: Project, symbolId: string) => string | undefined) | undefined;
  /** Extra CodeLens text per block (called-from summaries). */
  codeLensExtra: ((project: Project, blockId: string) => string | undefined) | undefined;
}
