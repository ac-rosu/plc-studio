// Converts a line in an exported file into the location TIA uses in its compile messages
// (docs/format-notes.md, finding 4):
// - SCL in .scl/.db: line n is the n-th line after BEGIN.
// - SCL block in .s7dcl: line n is the n-th line after NETWORK.
// - LAD/FBD block in .s7dcl (also its SCL networks): network n, the n-th NETWORK keyword.
// - Anything before the code (declarations): the interface, without a line.
// A message with neither line, network nor interface refers to the block as a whole.
import type { CompileMessage } from './expected.ts';

export type TiaLocation =
  | { readonly kind: 'line'; readonly line: number }
  | { readonly kind: 'network'; readonly network: number }
  | { readonly kind: 'interface' }
  | { readonly kind: 'block' };

const BEGIN = /^\s*BEGIN\s*$/;
const NETWORK = /^\s*NETWORK\s*$/;
const SCL_EDITOR = /^\s*S7_EditorMode\s*:=\s*"SCL"/;

/** @param fileLine 1-based line in the file. */
export function tiaLocation(text: string, fileLine: number, extension: string): TiaLocation {
  const lines = text.split(/\r?\n/);
  if (extension === '.s7dcl') {
    let network = 0;
    let networkLine = 0;
    for (let i = 0; i < fileLine && i < lines.length; i++) {
      if (NETWORK.test(lines[i]!)) {
        network++;
        networkLine = i + 1;
      }
    }
    if (network === 0) return { kind: 'interface' };
    if (!lines.some((line) => SCL_EDITOR.test(line))) return { kind: 'network', network };
    return fileLine === networkLine
      ? { kind: 'interface' }
      : { kind: 'line', line: fileLine - networkLine };
  }
  const beginLine = lines.findIndex((line) => BEGIN.test(line)) + 1;
  if (beginLine === 0 || fileLine <= beginLine) return { kind: 'interface' };
  return { kind: 'line', line: fileLine - beginLine };
}

/** The location a compile message refers to. */
export function messageLocation(message: CompileMessage): TiaLocation {
  if (message.line !== null) return { kind: 'line', line: message.line };
  if (message.network !== null) return { kind: 'network', network: message.network };
  return /> Interface$/.test(message.path) ? { kind: 'interface' } : { kind: 'block' };
}

/** Whether a diagnostic at `found` answers a message at `expected`. */
export function matchesLocation(expected: TiaLocation, found: TiaLocation): boolean {
  switch (expected.kind) {
    case 'line':
      return found.kind === 'line' && found.line === expected.line;
    case 'network':
      return found.kind === 'network' && found.network === expected.network;
    case 'interface':
      return found.kind === 'interface';
    case 'block':
      return true;
  }
}
