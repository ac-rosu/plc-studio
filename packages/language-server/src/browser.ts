// Browser entry point: runs inside a Web Worker (vscode.dev, github.dev).
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection,
} from 'vscode-languageserver/browser';
import { startServer } from './server.ts';

startServer(createConnection(new BrowserMessageReader(self), new BrowserMessageWriter(self)));
