// A short, colored preview of an SCL network inside a LAD/FBD block (owner, 2026-10-24: SCL is
// edited in the SCL editor, not in the drawing). Tokens come from core's lexer, so strings, comments
// and typed literals are cut where the checker cuts them. Each token gets the color role the
// editor's grammar gives it, and the editor's color for it (core/syntax/colors), light or dark as
// the theme is.
// the modules only: the whole of core would make the view's bundle ten times larger
import {
  LIGHT_THEME_MARK,
  SYNTAX_COLORS,
  SYNTAX_ROLES,
  type SyntaxRole,
} from '@plcstudio/core/syntax/colors';
import {
  SCL_CONSTANT_WORDS,
  SCL_CONTROL_KEYWORDS,
  SCL_WORD_OPERATORS,
} from '@plcstudio/core/syntax/keywords';
import { isInstruction, type InstructionNames } from '@plcstudio/core/syntax/instruction-names';
import { T, lex, type Token } from '@plcstudio/core/syntax/lexer';
import { h } from '../shared/dom.ts';

const KEYWORDS = new Set<string>([...SCL_CONTROL_KEYWORDS, ...SCL_WORD_OPERATORS]);
const CONSTANTS = new Set<string>(SCL_CONSTANT_WORDS);
const OPERATORS = new Set<T>([
  T.Assign,
  T.Output,
  T.Range,
  T.Le,
  T.Ge,
  T.Ne,
  T.Power,
  T.PlusAssign,
  T.MinusAssign,
  T.TimesAssign,
  T.DivAssign,
  T.Plus,
  T.Minus,
  T.Star,
  T.Slash,
  T.Lt,
  T.Gt,
  T.Eq,
  T.Ampersand,
  T.Caret,
]);

/**
 * The editor's colors: the dark set, and the light set where the theme id VS Code puts on the
 * webview's body contains "Light", as the editor's color defaults do.
 */
function paletteStyle(): HTMLStyleElement {
  const rule = (kind: 'light' | 'dark', role: SyntaxRole) =>
    `${kind === 'light' ? `body[data-vscode-theme-id*="${LIGHT_THEME_MARK}"]` : 'body'} pre.scl .tok-${role} { color: ${SYNTAX_COLORS[kind][role]}; }`;
  const style = document.createElement('style');
  style.id = 'scl-palette';
  style.textContent = (['dark', 'light'] as const)
    .flatMap((kind) => SYNTAX_ROLES.map((role) => rule(kind, role)))
    .join('\n');
  return style;
}

/**
 * The color role of each token, by the rules of the editor's grammar: a REGION line in the region's
 * color, a call of an instruction in the instruction's and a call of a block as plain text, names
 * of the block (#…), globals ("…", _.…) and members as tags, formal parameters apart.
 */
function roles(
  tokens: readonly Token[],
  text: string,
  instruction: (word: string) => boolean,
): (SyntaxRole | undefined)[] {
  const out: (SyntaxRole | undefined)[] = [];
  const kind = (i: number) => tokens[i]?.kind;
  const word = (i: number) => text.slice(tokens[i]!.start, tokens[i]!.end);
  // the next token on the same line that is not a blank
  const next = (i: number) => {
    let j = i + 1;
    while (kind(j) === T.Whitespace) j++;
    return j;
  };
  // the last identifier of a dotted name starting at i (_.Lib.FC_X, Unit.FC_X)
  const pathEnd = (i: number) => {
    let j = i;
    while (kind(j + 1) === T.Dot && kind(j + 2) === T.Identifier) j += 2;
    return j;
  };
  let regionLine = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === T.Newline) regionLine = false;
    if (regionLine) {
      out[i] = t.kind === T.Whitespace ? undefined : 'region';
      continue;
    }
    switch (t.kind) {
      case T.LineComment:
      case T.BlockComment:
        out[i] = 'comment';
        break;
      case T.String:
      case T.Number:
      case T.TypedLiteral:
        out[i] = 'literal';
        break;
      case T.Hash:
      case T.Address:
        out[i] = 'tag';
        break;
      case T.Quoted:
        // a global, or a called block ("FC_X"(…)) as plain text
        out[i] = kind(next(i)) === T.LParen && kind(i - 1) !== T.Hash ? undefined : 'tag';
        break;
      case T.Identifier: {
        const upper = word(i).toUpperCase();
        const call = kind(next(i)) === T.LParen;
        if (kind(i - 1) === T.Hash) out[i] = 'tag';
        else if (kind(i - 1) === T.Dot)
          out[i] = call ? (instruction(upper) ? 'instruction' : undefined) : 'tag';
        else if (upper === 'REGION') {
          out[i] = 'region';
          regionLine = true;
        } else if (upper === 'END_REGION') out[i] = 'region';
        else if (KEYWORDS.has(upper) || CONSTANTS.has(upper)) out[i] = 'keyword';
        else {
          const end = pathEnd(i);
          const pathCall = kind(next(end)) === T.LParen;
          if (pathCall) {
            // an instruction, or a block whose call stays plain text
            out[i] = end === i && instruction(upper) ? 'instruction' : undefined;
            for (let j = i + 1; j <= end; j++) out[j] = undefined;
            i = end;
          } else if (upper === '_' && end > i) {
            for (let j = i; j <= end; j++) out[j] = kind(j) === T.Identifier ? 'tag' : undefined;
            i = end;
          } else if (kind(next(i)) === T.Assign || kind(next(i)) === T.Output) out[i] = 'parameter';
        }
        break;
      }
      default:
        out[i] = OPERATORS.has(t.kind) ? 'operator' : undefined;
    }
  }
  return out;
}

/**
 * At most `maxLines` lines of `text`, colored; `hidden` counts the lines left out. `names` are the
 * profile's instruction names (the view's model has them).
 */
export function sclPreview(
  text: string,
  maxLines: number,
  names: InstructionNames = { instructions: [], types: [] },
): { element: HTMLElement; hidden: number } {
  if (!document.getElementById('scl-palette')) document.head.append(paletteStyle());
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, maxLines).join('\n');
  const pre = h('pre', { class: 'code scl' });
  const tokens = lex(shown).filter((t) => t.kind !== T.EOF);
  const kinds = roles(tokens, shown, isInstruction(names));
  tokens.forEach((t, i) => {
    const word = shown.slice(t.start, t.end);
    const kind = kinds[i];
    pre.append(kind ? h('span', { class: `tok-${kind}` }, word) : word);
  });
  return { element: pre, hidden: Math.max(0, lines.length - maxLines) };
}
