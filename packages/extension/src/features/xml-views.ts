// SimaticML blocks and PLC data types, shown read-only (ADR 0014): what a file holds decides the
// view, as for the text formats. Data blocks open in the data block editor and PLC data types in
// the interface table, both with models taken from the XML; SCL blocks open as a read-only SCL
// document rebuilt from the XML, in a language of its own, so the checker never sees it.
import * as vscode from 'vscode';
import { readSimaticmlBlock, simaticmlToScl, type SimaticmlBlock } from '@plcstudio/core';
import { XML_READ_ONLY_NOTE } from './xml-models.ts';

export const XML_SCL_SCHEME = 'plcstudio-simaticml';
export const XML_SCL_LANGUAGE = 'plcstudio-scl-readonly';

export type XmlView = 'datablock' | 'interface' | 'ladder' | 'scl' | 'text';

const cache = new Map<string, { version: number; block: SimaticmlBlock | undefined }>();

/** The SimaticML block or PLC data type in the document, if it holds one. */
export function xmlBlock(document: vscode.TextDocument): SimaticmlBlock | undefined {
  if (!/\.xml$/i.test(document.uri.path)) return undefined;
  const key = document.uri.toString();
  const hit = cache.get(key);
  if (hit && hit.version === document.version) return hit.block;
  const text = document.getText();
  const block = /<SW\.(Blocks\.\w+|Types\.PlcStruct)\b/.test(text)
    ? readSimaticmlBlock(text)
    : undefined;
  cache.set(key, { version: document.version, block });
  return block;
}

export function xmlView(block: SimaticmlBlock): XmlView {
  if (block.kind === 'GlobalDB' || block.kind === 'InstanceDB' || block.kind === 'ArrayDB')
    return 'datablock';
  if (block.kind === 'UDT') return 'interface';
  const languages = block.networks.map((n) => n.language.replace(/^F_/, ''));
  if (languages.some((l) => l === 'LAD' || l === 'FBD')) return 'ladder';
  if (languages.length > 0 && languages.every((l) => l === 'SCL')) return 'scl';
  return 'text';
}

/** Display language: the setting, else English, else the first language the file has. */
export function xmlCulture(block: SimaticmlBlock): string {
  const setting = vscode.workspace.getConfiguration('plcstudio').get<string>('displayLanguage');
  if (setting) return setting;
  const cultures = new Set<string>();
  const add = (texts: Readonly<Record<string, string>>) =>
    Object.keys(texts).forEach((c) => cultures.add(c));
  add(block.title);
  add(block.comment);
  const walk = (members: SimaticmlBlock['sections'][number]['members']) =>
    members.forEach((m) => {
      add(m.comment);
      walk(m.members);
    });
  block.sections.forEach((s) => walk(s.members));
  return cultures.has('en-US') ? 'en-US' : ([...cultures][0] ?? 'en-US');
}

/** The read-only SCL document of an XML file: "<name> (SimaticML)" next to it. */
function sclUri(xml: vscode.Uri): vscode.Uri {
  return vscode.Uri.from({
    scheme: XML_SCL_SCHEME,
    path: `${xml.path.replace(/\.xml$/i, '')} (SimaticML)`,
    query: xml.toString(),
  });
}

export async function openXmlScl(
  xml: vscode.Uri,
  options: vscode.TextDocumentShowOptions,
): Promise<void> {
  let document = await vscode.workspace.openTextDocument(sclUri(xml));
  if (document.languageId !== XML_SCL_LANGUAGE)
    document = await vscode.languages.setTextDocumentLanguage(document, XML_SCL_LANGUAGE);
  await vscode.window.showTextDocument(document, options);
}

export function registerXmlViews(extension: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<vscode.Uri>();
  extension.subscriptions.push(
    changed,
    vscode.workspace.registerTextDocumentContentProvider(XML_SCL_SCHEME, {
      onDidChange: changed.event,
      async provideTextDocumentContent(uri) {
        const xml = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri.query));
        const block = xmlBlock(xml);
        return block
          ? simaticmlToScl(block, xmlCulture(block), XML_READ_ONLY_NOTE)
          : '// This file no longer holds a SimaticML block.\n';
      },
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (/\.xml$/i.test(e.document.uri.path)) changed.fire(sclUri(e.document.uri));
    }),
  );
}
