// The language server, shared by the Node and the browser entry points. It sees only an LSP
// connection; everything else comes from core (ADR 0006).
import {
  TextDocumentSyncKind,
  TextDocuments,
  type Connection,
  type ServerCapabilities,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

export function serverCapabilities(): ServerCapabilities {
  return { textDocumentSync: TextDocumentSyncKind.Incremental };
}

export function startServer(connection: Connection): void {
  const documents = new TextDocuments(TextDocument);
  connection.onInitialize(() => ({
    capabilities: serverCapabilities(),
    serverInfo: { name: 'PLC Studio' },
  }));
  documents.listen(connection);
  connection.listen();
}
