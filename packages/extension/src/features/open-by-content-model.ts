// Which view fits a PLC file (owner, 2026-10-24): LAD/FBD blocks open in the LAD/FBD view, data
// blocks in the data block editor, PLC data types in the interface table, and everything else
// (SCL blocks, files mixing kinds of blocks, files that do not parse) in the text editor, where
// every code feature works. Free of the VS Code API, so the corpus tests can check it.
import type { Block, BlockFile } from '@plcstudio/core';

export type ContentView = 'ladder' | 'datablock' | 'interface' | 'text';

export function viewForContent(file: BlockFile | undefined): ContentView {
  const blocks = file?.blocks ?? [];
  if (!file || blocks.length === 0) return 'text';
  if (blocks.every((b) => b.kind === 'DB')) return 'datablock';
  if (blocks.every((b) => b.kind === 'UDT')) return 'interface';
  // LAD and FBD exist only in SIMATIC SD documents, one block per file
  if (file.format === 's7dcl' && blocks.length === 1 && isLadderBlock(blocks[0]!)) return 'ladder';
  return 'text';
}

/** A code block with a LAD or FBD network, or without networks but meant for LAD or FBD. */
function isLadderBlock(block: Block): boolean {
  if (block.kind !== 'OB' && block.kind !== 'FB' && block.kind !== 'FC') return false;
  if (block.networks.some((n) => n.language === 'LAD' || n.language === 'FBD')) return true;
  const preferred = block.attributes.find((a) => a.name === 'S7_PreferredLanguage')?.value;
  return block.networks.length === 0 && (preferred === 'LAD' || preferred === 'FBD');
}
