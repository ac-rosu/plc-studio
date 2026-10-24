// A SimaticML FB, FC or OB as a SIMATIC SD document, for the LAD/FBD view (ADR 0014): networks
// become SD rungs (flgnet.ts) or SCL text, titles and comments go into a resource text. Only
// drawn, never saved or checked; a network that cannot be translated keeps a note why.
import type { ProfileIndex } from '@plcstudio/profiles';
import type { SimaticmlBlock, SimaticmlTexts } from './block.ts';
import { flgNetToRungs } from './flgnet.ts';
import { structuredText } from './structured-text.ts';

const SECTION_KEYWORDS: Readonly<Record<string, string>> = {
  Input: 'VAR_INPUT',
  Output: 'VAR_OUTPUT',
  InOut: 'VAR_IN_OUT',
  Static: 'VAR',
  Temp: 'VAR_TEMP',
  Constant: 'VAR CONSTANT',
};

export interface SimaticmlSd {
  readonly s7dcl: string;
  readonly s7res: string;
  /** Networks that could not be translated, with the reason. */
  readonly untranslated: readonly { readonly index: number; readonly reason: string }[];
}

const CRLF = '\r\n';
const yamlText = (s: string) =>
  /^[\w .,;:!?()'"-]*$/.test(s) && !/^['"]/.test(s) ? s : JSON.stringify(s);

export function simaticmlToSd(block: SimaticmlBlock, profile: ProfileIndex): SimaticmlSd {
  const lines: string[] = [];
  const resources: string[] = ['MultiLingualTexts:'];
  const text = (id: string, texts: SimaticmlTexts) => {
    const entries = Object.entries(texts).filter(([, t]) => t !== '');
    if (entries.length === 0) return false;
    resources.push(`  - id: ${id}`);
    for (const [culture, t] of entries)
      resources.push(`    ${culture}: ${yamlText(t.replace(/\r?\n/g, ' '))}`);
    return true;
  };
  const language = block.language.replace(/^F_/, '');
  const attributes = [
    ...(language === 'LAD' || language === 'FBD' ? [`S7_PreferredLanguage := "${language}"`] : []),
    ...(block.failsafe ? ['S7_Safety := "TRUE"'] : []),
  ];
  if (attributes.length > 0)
    lines.push('{', attributes.map((a) => `    ${a}`).join(`;${CRLF}`), '}');
  const name = `"${block.name}"`;
  const ret = block.sections.find((s) => s.name === 'Return')?.members[0]?.datatype ?? 'Void';
  const [open, close] =
    block.kind === 'FB'
      ? [`FUNCTION_BLOCK ${name}`, 'END_FUNCTION_BLOCK']
      : block.kind === 'FC'
        ? [`FUNCTION ${name} : ${ret}`, 'END_FUNCTION']
        : [`ORGANIZATION_BLOCK ${name}`, 'END_ORGANIZATION_BLOCK'];
  lines.push(open);
  for (const section of block.sections) {
    const keyword = SECTION_KEYWORDS[section.name];
    if (!keyword || section.members.length === 0) continue;
    lines.push(`    ${keyword}`);
    for (const m of section.members) lines.push(`        ${m.name} : ${m.datatype};`);
    lines.push('    END_VAR');
  }
  lines.push('');
  const untranslated: { index: number; reason: string }[] = [];
  for (const n of block.networks) {
    const lang = n.language.replace(/^F_/, '');
    const attrs = [`S7_Language := "${lang === 'LAD' || lang === 'FBD' ? lang : 'SCL'}"`];
    if (text(`N${n.index}C`, n.comment)) attrs.push(`S7_NetworkComment := "N${n.index}C"`);
    if (text(`N${n.index}T`, n.title)) attrs.push(`S7_NetworkTitle := "N${n.index}T"`);
    lines.push('    {', attrs.map((a) => `        ${a}`).join(`;${CRLF}`), '    }', '    NETWORK');
    if (n.source && lang === 'SCL') {
      for (const l of structuredText(n.source, { namespace: block.namespace }).split('\n'))
        lines.push(`        ${l}`);
    } else if (n.source && (lang === 'LAD' || lang === 'FBD')) {
      const result = flgNetToRungs(n.source, {
        profile,
        language: lang,
        namespace: block.namespace,
      });
      if ('lines' in result) lines.push(...result.lines.map((l) => `        ${l}`));
      else {
        untranslated.push({ index: n.index, reason: result.unsupported });
        lines.push(`        // Not drawn from SimaticML: ${result.unsupported}`);
      }
    } else if (n.source) {
      untranslated.push({ index: n.index, reason: `${n.language} network` });
      lines.push(`        // Not drawn from SimaticML: ${n.language} network`);
    }
    lines.push('    END_NETWORK');
  }
  lines.push(close);
  return { s7dcl: lines.join(CRLF) + CRLF, s7res: resources.join(CRLF) + CRLF, untranslated };
}
