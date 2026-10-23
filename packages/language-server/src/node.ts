// Node entry point: the desktop extension starts this file as the server process.
import { ProposedFeatures, createConnection } from 'vscode-languageserver/node';
import { startServer } from './server.ts';

startServer(createConnection(ProposedFeatures.all));
