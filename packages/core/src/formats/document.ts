// Chooses the parser by file name and gives every format the same entry point.
import type { BlockFile } from '../syntax/ast.ts';
import { parseBlockFile } from '../syntax/parser.ts';
import { SourceText } from '../text/source-text.ts';
import { parseResources, type ResourceFile } from './s7res.ts';
import { parseTagTable, type TagTableFile } from './tag-table.ts';

export type ParsedFile = BlockFile | ResourceFile | TagTableFile;
export type FileKind = 's7dcl' | 's7res' | 'source' | 'tagTable' | 'manifest' | 'rules' | 'other';

export function fileKindOf(path: string): FileKind {
  const lower = path.toLowerCase();
  const base = lower.slice(Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1);
  if (base === 'plc.json') return 'manifest';
  if (base === 'plcstudio.rules.json') return 'rules';
  if (lower.endsWith('.s7dcl')) return 's7dcl';
  if (lower.endsWith('.s7res')) return 's7res';
  if (lower.endsWith('.scl') || lower.endsWith('.udt') || lower.endsWith('.db')) return 'source';
  if (lower.endsWith('.xml')) return 'tagTable';
  return 'other';
}

export function parseSource(path: string, source: SourceText): ParsedFile | undefined {
  switch (fileKindOf(path)) {
    case 's7dcl':
      return parseBlockFile(source, 's7dcl');
    case 'source':
      return parseBlockFile(source, 'source');
    case 's7res':
      return parseResources(source);
    case 'tagTable':
      // other SimaticML (OB exports, blocks) is read where needed, not reported
      return source.text.includes('SW.Tags.PlcTagTable') ? parseTagTable(source) : undefined;
    default:
      return undefined;
  }
}

export function parseBytes(path: string, bytes: Uint8Array): ParsedFile | undefined {
  return parseSource(path, SourceText.fromBytes(bytes));
}

/** Prints an unchanged parse result. Block files print their tokens, which cover every character. */
export function printFile(file: ParsedFile): string {
  if (file.kind === 'blocks') {
    let out = '';
    for (const t of file.tokens) out += file.source.text.slice(t.start, t.end);
    return out;
  }
  return file.source.text;
}
