// The read-only SCL view of a SimaticML block (ADR 0014): the block as an external source would
// show it, with declarations, comments in the display language and the code rebuilt from the
// XML. Shown, never saved or checked.
import type { SimaticmlBlock, SimaticmlMember, SimaticmlTexts } from './block.ts';
import { structuredText } from './structured-text.ts';

const SECTION_KEYWORDS: Readonly<Record<string, string>> = {
  Input: 'VAR_INPUT',
  Output: 'VAR_OUTPUT',
  InOut: 'VAR_IN_OUT',
  Static: 'VAR',
  Temp: 'VAR_TEMP',
  Constant: 'VAR CONSTANT',
};

/**
 * The default value of an array as one initializer, from the start values of its elements:
 * [1.0, 2.0, 8(0.5)], runs of equal values with a repetition factor as TIA writes them.
 */
export function memberInitializer(m: SimaticmlMember): string | undefined {
  if (m.elements.length === 0) return m.startValue;
  const values = m.elements.map((e) => e.value);
  const parts: string[] = [];
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j < values.length && values[j] === values[i]) j++;
    parts.push(j - i > 1 ? `${j - i}(${values[i]})` : values[i]!);
    i = j;
  }
  return `[${parts.join(', ')}]`;
}

/** Comment text in the culture, else in the first culture that has one. */
function textIn(texts: SimaticmlTexts, culture: string): string | undefined {
  return texts[culture] ?? Object.values(texts)[0];
}

function members(list: readonly SimaticmlMember[], indent: string, culture: string, out: string[]) {
  for (const m of list) {
    const comment = textIn(m.comment, culture);
    const note = comment ? `   // ${comment.replace(/\r?\n/g, ' ')}` : '';
    if (m.datatype === 'Struct') {
      out.push(`${indent}${m.name} : Struct${note}`);
      members(m.members, `${indent}   `, culture, out);
      out.push(`${indent}END_STRUCT;`);
      continue;
    }
    const initial = memberInitializer(m);
    out.push(
      `${indent}${m.name} : ${m.datatype}${initial !== undefined ? ` := ${initial}` : ''};${note}`,
    );
  }
}

/**
 * The SCL view of an FB, FC or OB, lines separated by \n; `note` heads it as a comment. A block
 * of a software unit sits in its NAMESPACE, as TIA's external source writes it (corpus C22).
 */
export function simaticmlToScl(block: SimaticmlBlock, culture: string, note: string): string {
  const quoted = `"${block.name}"`;
  const ret = block.sections.find((s) => s.name === 'Return')?.members[0]?.datatype ?? 'Void';
  const [open, close] =
    block.kind === 'FB'
      ? [`FUNCTION_BLOCK ${quoted}`, 'END_FUNCTION_BLOCK']
      : block.kind === 'FC'
        ? [`FUNCTION ${quoted} : ${ret}`, 'END_FUNCTION']
        : [`ORGANIZATION_BLOCK ${quoted}`, 'END_ORGANIZATION_BLOCK'];
  const out = [`// ${note}`, ...(block.namespace ? [`NAMESPACE ${block.namespace}`] : []), open];
  const title = textIn(block.title, culture);
  if (title) out.push(`TITLE = ${title}`);
  const comment = textIn(block.comment, culture);
  if (comment) for (const line of comment.split(/\r?\n/)) out.push(`//${line}`);
  for (const section of block.sections) {
    const keyword = SECTION_KEYWORDS[section.name];
    if (!keyword) continue;
    out.push(`   ${keyword} `);
    members(section.members, '      ', culture, out);
    out.push('   END_VAR', '');
  }
  out.push('', 'BEGIN');
  const scl = block.networks.filter((n) => n.language === 'SCL' && n.source);
  scl.forEach((n, i) => {
    if (scl.length > 1) out.push(`\t// Network ${n.index}`);
    for (const line of structuredText(n.source!, { namespace: block.namespace }).split('\n'))
      out.push(`\t${line}`);
    if (i < scl.length - 1) out.push('');
  });
  out.push(close, ...(block.namespace ? ['END_NAMESPACE'] : []), '');
  return out.join('\n');
}
