// DB start values: the assignment lines after the declarations of a SIMATIC SD data block, and
// after BEGIN in an external source (format-notes). Global, array and instance DBs.
import type { Assignment, Block, BlockFile } from '../syntax/ast.ts';
import { Parser } from '../syntax/parser.ts';
import { SourceText } from '../text/source-text.ts';
import {
  conversionProblem,
  integerLiteralValue,
  integerOutOfRange,
  isUnknown,
  typeName,
  type DataType,
} from '../model/types.ts';
import type { ProfileIndex } from '@plcstudio/profiles';
import { failed, indentOf, lineSpan, lineStartOf, type EditResult } from './common.ts';

/** Normalized target text: `Limits.Minimum`, `Speeds[0]`. */
export function startValueKey(file: BlockFile, a: Assignment): string {
  return file.source.slice(a.target.range).replace(/\s+/g, '').toLowerCase();
}

export function findStartValue(
  file: BlockFile,
  block: Block,
  path: string,
): Assignment | undefined {
  const key = path.replace(/\s+/g, '').toLowerCase();
  return block.startValues.find((a) => startValueKey(file, a) === key);
}

/** The value text of a start value, as written. */
export function startValueText(file: BlockFile, block: Block, path: string): string | undefined {
  const a = findStartValue(file, block, path);
  return a ? file.source.slice(a.value.range) : undefined;
}

/** Sets, changes or (with undefined) removes the start value of one member or array element. */
export function setStartValue(
  file: BlockFile,
  block: Block,
  path: string,
  value: string | undefined,
): EditResult {
  if (block.kind !== 'DB') return failed('Start values exist only in data blocks.');
  const source = file.source;
  const nl = source.newline;
  const existing = findStartValue(file, block, path);
  const v = value?.trim();
  if (existing) {
    if (!v) {
      const span = lineSpan(source, existing.range);
      return { edits: [{ start: span.start, end: span.end, newText: '' }] };
    }
    return {
      edits: [{ start: existing.value.range.start, end: existing.value.range.end, newText: v }],
    };
  }
  if (!v) return { edits: [] };
  const last = block.startValues[block.startValues.length - 1];
  const sd = file.format === 's7dcl';
  const blockIndent = indentOf(source, block.range.start);
  // after BEGIN TIA indents a global DB's start values by 3 spaces, an array DB's by 4 (C02, C40)
  const arrayDb = block.dbType?.kind === 'array';
  const indent = last
    ? indentOf(source, last.range.start)
    : blockIndent + (sd || arrayDb ? '    ' : '   ');
  const line = `${indent}${path} := ${v};${nl}`;
  // elements of one array stay in index order, as TIA writes them (THIS[1] before THIS[3])
  const indexed = /^(.*)\[(-?\d+)\]$/.exec(path.replace(/\s+/g, ''));
  if (indexed) {
    const [, base, n] = indexed;
    const next = block.startValues.find((a) => {
      const m = /^(.*)\[(-?\d+)\]$/.exec(startValueKey(file, a));
      return m && m[1] === base!.toLowerCase() && Number(m[2]) > Number(n);
    });
    if (next) {
      const at = lineSpan(source, next.range).start;
      return { edits: [{ start: at, end: at, newText: line }] };
    }
  }
  if (last) {
    const at = lineSpan(source, last.range).end;
    return { edits: [{ start: at, end: at, newText: line }] };
  }
  // no start values yet: before the blank line that precedes END_DATA_BLOCK, else before END_DATA_BLOCK
  const endKeyword = lineStartOf(source, block.range.end - 'END_DATA_BLOCK'.length);
  const endLine = source.positionAt(endKeyword).line;
  const prevBlank =
    endLine > 0 && source.lineText(endLine - 1).trim() === ''
      ? source.lineStart(endLine - 1)
      : undefined;
  const hasDeclarations = block.sections.length > 0;
  if (sd && hasDeclarations && prevBlank === undefined) {
    // C02 layout: END_VAR, blank line, start values, blank line, END_DATA_BLOCK
    return { edits: [{ start: endKeyword, end: endKeyword, newText: `${nl}${line}${nl}` }] };
  }
  const at = prevBlank ?? endKeyword;
  return { edits: [{ start: at, end: at, newText: line }] };
}

/** Checks a start value against the member's type; returns a message when it does not fit. */
export function validateStartValue(
  type: DataType,
  text: string,
  profile: ProfileIndex,
): string | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const parser = new Parser(new SourceText(t));
  const expr = parser.parseExpression();
  if (parser.diagnostics.some((d) => d.severity === 'error') || parser.tok().start < t.length)
    return `${t} is not a valid value.`;
  const v = integerLiteralValue(expr);
  if (v !== undefined && integerOutOfRange(type, v))
    return `${t} is outside the range of ${typeName(type)}.`;
  if (isUnknown(type)) return undefined;
  let valueType: DataType = { kind: 'unknown', text: '' };
  if (expr.kind === 'literal') {
    if (expr.literalKind === 'bool') {
      const b = profile.elementary('Bool');
      if (b) valueType = { kind: 'elementary', name: b.name, info: b };
    } else if (expr.literalKind === 'typed') {
      const info = profile.literalType(expr.prefix ?? '');
      if (info) valueType = { kind: 'elementary', name: info.name, info };
    } else if (expr.literalKind === 'string') {
      const s = profile.elementary('String');
      if (s && type.kind === 'elementary' && type.info.class !== 'char')
        valueType = { kind: 'elementary', name: s.name, info: s };
    }
  }
  const problem = conversionProblem(type, valueType, false, expr);
  return problem?.severity === 'error' ? problem.message : undefined;
}
