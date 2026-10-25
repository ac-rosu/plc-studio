// A short, colored preview of an SCL network inside a LAD/FBD block (owner, 2026-10-24: SCL is
// edited in the SCL editor, not in the drawing). Colors come from the theme; tokens from core's
// lexer, so strings, comments and typed literals are cut where the checker cuts them.
// the two modules only: the whole of core would make the view's bundle ten times larger
import {
  SCL_CONSTANT_WORDS,
  SCL_CONTROL_KEYWORDS,
  SCL_WORD_OPERATORS,
} from '@plcstudio/core/syntax/keywords';
import { T, lex } from '@plcstudio/core/syntax/lexer';
import { h } from '../shared/dom.ts';

const KEYWORDS = new Set<string>([...SCL_CONTROL_KEYWORDS, ...SCL_WORD_OPERATORS]);
const CONSTANTS = new Set<string>(SCL_CONSTANT_WORDS);

/** At most `maxLines` lines of `text`, colored; `hidden` counts the lines left out. */
export function sclPreview(
  text: string,
  maxLines: number,
): { element: HTMLElement; hidden: number } {
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, maxLines).join('\n');
  const pre = h('pre', { class: 'code scl' });
  let local = false;
  for (const t of lex(shown)) {
    if (t.kind === T.EOF) break;
    const word = shown.slice(t.start, t.end);
    let kind: string | undefined;
    if (t.kind === T.LineComment || t.kind === T.BlockComment) kind = 'comment';
    else if (t.kind === T.String) kind = 'string';
    else if (t.kind === T.Number || t.kind === T.TypedLiteral) kind = 'number';
    else if (t.kind === T.Quoted) kind = local ? 'local' : 'global';
    else if (t.kind === T.Hash) kind = 'local';
    else if (t.kind === T.Identifier) {
      const upper = word.toUpperCase();
      kind = local
        ? 'local'
        : KEYWORDS.has(upper)
          ? 'keyword'
          : CONSTANTS.has(upper)
            ? 'constant'
            : undefined;
    }
    local = t.kind === T.Hash;
    pre.append(kind ? h('span', { class: `tok-${kind}` }, word) : word);
  }
  return { element: pre, hidden: Math.max(0, lines.length - maxLines) };
}
