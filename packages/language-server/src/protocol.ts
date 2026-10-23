// Custom requests between the client and the language server, beyond LSP. No imports, so the
// extension can use the types without pulling in the server.

/** Server → client: file access through the editor (keeps the server web-safe, ADR 0006). */
export const READ_DIRECTORY = 'plcstudio/readDirectory';
export const READ_FILE = 'plcstudio/readFile';

/** Client → server: the call tree view and the Trace value view. */
export const CALL_TREE = 'plcstudio/callTree';
export const TRACE_VALUE = 'plcstudio/traceValue';

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

/** One node of the call tree view, with a location the client can open. */
export interface CallTreeItem {
  name: string;
  kind: 'ob' | 'fb' | 'fc' | 'instruction' | 'unresolved';
  /** "every call", "if #Start", "in a loop", "via EN", the instance … */
  detail: string;
  uri: string;
  range: Range;
  recursive: boolean;
  children: CallTreeItem[];
}

export interface CallTreePlc {
  name: string;
  uri: string;
  roots: CallTreeItem[];
}

export interface TraceItem {
  uri: string;
  range: Range;
  access: string;
  blockName: string;
  via: string[];
  /** The source line, trimmed. */
  line: string;
}

export interface TraceResult {
  name: string;
  items: TraceItem[];
}
