// Data types as the checker sees them, and the implicit-conversion rules. A conversion is an
// error only where a corpus case shows TIA rejects it; everything else uncertain is a warning
// or nothing (ADR 0003).
import type { ElementaryType, SystemType, TypeClass } from '@plcstudio/profiles';
import type { Expression, Member, SectionKind } from '../syntax/ast.ts';
import type { Range } from '../text/source-text.ts';

export interface MemberInfo {
  readonly name: string;
  readonly type: DataType;
  /** Interface section of a block member; undefined for struct and UDT fields. */
  readonly section: SectionKind | 'Return' | undefined;
  /** Symbol id, e.g. member:fb_x/limits.minimum */
  readonly id: string;
  readonly declaration: { readonly file: string; readonly range: Range } | undefined;
  readonly node: Member | undefined;
}

export interface BlockRef {
  readonly id: string;
  readonly name: string;
  readonly namespace: string | undefined;
}

export type DataType =
  | {
      readonly kind: 'elementary';
      readonly name: string;
      readonly info: ElementaryType;
      readonly length?: number | undefined;
    }
  | {
      readonly kind: 'array';
      readonly dimensions: readonly {
        readonly lower: number | undefined;
        readonly upper: number | undefined;
      }[];
      readonly star: boolean;
      readonly element: DataType;
    }
  | { readonly kind: 'struct'; readonly members: readonly MemberInfo[] }
  | {
      readonly kind: 'udt';
      readonly block: BlockRef;
      readonly members: () => readonly MemberInfo[];
      readonly failsafe: boolean;
    }
  | { readonly kind: 'fb'; readonly block: BlockRef; readonly members: () => readonly MemberInfo[] }
  | { readonly kind: 'system'; readonly type: SystemType }
  | { readonly kind: 'ref'; readonly target: DataType }
  /** A generic parameter class from the profile: ANY, ANY_NUM, ANY_INT ... */
  | { readonly kind: 'generic'; readonly name: string }
  | { readonly kind: 'unknown'; readonly text: string };

export const UNKNOWN: DataType = { kind: 'unknown', text: '' };

export function typeName(t: DataType): string {
  switch (t.kind) {
    case 'elementary':
      return t.length !== undefined ? `${t.info.name}[${t.length}]` : t.info.name;
    case 'array':
      return `Array[${t.star ? '*' : t.dimensions.map((d) => `${d.lower ?? '?'}..${d.upper ?? '?'}`).join(', ')}] of ${typeName(t.element)}`;
    case 'struct':
      return 'Struct';
    case 'udt':
    case 'fb':
      return `"${t.block.namespace ? t.block.namespace + '.' : ''}${t.block.name}"`;
    case 'system':
      return t.type.name;
    case 'ref':
      return `REF_TO ${typeName(t.target)}`;
    case 'generic':
      return t.name;
    case 'unknown':
      return t.text || 'unknown type';
  }
}

export function classOf(t: DataType): TypeClass | 'struct' | 'fb' | 'array' | 'ref' | 'unknown' {
  switch (t.kind) {
    case 'elementary':
      return t.info.class;
    case 'array':
      return 'array';
    case 'struct':
    case 'udt':
      return 'struct';
    case 'system':
      return t.type.kind === 'fb' ? 'fb' : t.type.name.toUpperCase() === 'DTL' ? 'dt' : 'struct';
    case 'fb':
      return 'fb';
    case 'ref':
      return 'ref';
    default:
      return 'unknown';
  }
}

export function membersOf(t: DataType): readonly MemberInfo[] | undefined {
  switch (t.kind) {
    case 'struct':
      return t.members;
    case 'udt':
    case 'fb':
      return t.members();
    default:
      return undefined;
  }
}

export function isUnknown(t: DataType): boolean {
  return t.kind === 'unknown' || t.kind === 'generic';
}

const isNumericClass = (c: string) => c === 'int' || c === 'real';

/** Does a value of type `t` fit a generic parameter class? undefined = cannot tell. */
export function fitsGeneric(generic: string, t: DataType): boolean | undefined {
  const c = classOf(t);
  if (c === 'unknown') return undefined;
  switch (generic.toUpperCase()) {
    case 'ANY':
    case 'VARIANT':
      return true;
    case 'ANY_NUM':
      return isNumericClass(c) ? true : c === 'bool' || c === 'string' ? false : undefined;
    case 'ANY_INT':
      return c === 'int'
        ? true
        : c === 'bool' || c === 'string' || c === 'real'
          ? false
          : undefined;
    case 'ANY_REAL':
      return c === 'real' ? true : c === 'bool' || c === 'string' ? false : undefined;
    case 'ANY_BIT':
      return c === 'bit' || c === 'bool'
        ? true
        : c === 'string' || c === 'real'
          ? false
          : undefined;
    case 'ANY_STRING':
      return c === 'string' || c === 'char'
        ? true
        : c === 'bool' || isNumericClass(c) || c === 'bit'
          ? false
          : undefined;
    default:
      return undefined;
  }
}

export interface ConversionProblem {
  readonly rule: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

function bitsOf(t: DataType): number {
  return t.kind === 'elementary' ? t.info.bits : 0;
}

/**
 * What TIA says about using `source` where `target` is expected. `literal` is the source
 * expression when it is a literal (integer literals into Time are rejected: corpus B14).
 */
export function conversionProblem(
  target: DataType,
  source: DataType,
  iecCheck: boolean,
  sourceExpression: Expression | undefined,
): ConversionProblem | undefined {
  // A plain number where a duration is expected (corpus B14: PT := 5).
  if (
    sourceExpression?.kind === 'literal' &&
    sourceExpression.literalKind === 'int' &&
    target.kind === 'elementary' &&
    target.info.class === 'time'
  ) {
    return {
      rule: 'type-mismatch',
      severity: 'error',
      message: `The number ${sourceExpression.text} cannot be used where ${typeName(target)} is expected; write a duration such as T#5s.`,
    };
  }
  if (isUnknown(target) || isUnknown(source)) return undefined;
  const tc = classOf(target);
  const sc = classOf(source);
  if (
    tc === 'unknown' ||
    sc === 'unknown' ||
    tc === 'pointer' ||
    sc === 'pointer' ||
    tc === 'ref' ||
    sc === 'ref'
  )
    return undefined;
  const tn = typeName(target);
  const sn = typeName(source);
  if (
    target.kind === 'elementary' &&
    source.kind === 'elementary' &&
    target.info.name === source.info.name
  )
    return undefined;

  // Bool and numbers do not mix (corpus B18: Int on a contact; B20: Bool on an Int input).
  if ((tc === 'bool' && isNumericClass(sc)) || (sc === 'bool' && isNumericClass(tc))) {
    return {
      rule: 'type-mismatch',
      severity: 'error',
      message: `A ${sn} value cannot be used where ${tn} is expected.`,
    };
  }
  // Nothing converts implicitly into a string except characters (corpus B17: Real into String).
  if (tc === 'string' && sc !== 'string' && sc !== 'char') {
    return {
      rule: 'type-mismatch',
      severity: 'error',
      message: `A ${sn} value cannot be used where ${tn} is expected; convert it explicitly.`,
    };
  }
  if (sc === 'string' && tc !== 'string' && tc !== 'char') {
    return {
      rule: 'type-mismatch',
      severity: 'error',
      message: `A ${sn} value cannot be used where ${tn} is expected; convert it explicitly.`,
    };
  }
  // A plain number where a duration is expected (corpus B14: PT := 5).
  if (
    tc === 'time' &&
    sc === 'int' &&
    sourceExpression?.kind === 'literal' &&
    sourceExpression.literalKind === 'int'
  ) {
    return {
      rule: 'type-mismatch',
      severity: 'error',
      message: `The number ${sourceExpression.text} cannot be used where ${tn} is expected; write a duration such as T#5s.`,
    };
  }
  if (tc === 'time' && (sc === 'int' || sc === 'real' || sc === 'bit')) {
    return {
      rule: 'possible-type-mismatch',
      severity: 'warning',
      message: `A ${sn} value is used where ${tn} is expected; TIA may reject this (not yet verified against TIA).`,
    };
  }
  // Structured types must match.
  if (
    tc === 'struct' ||
    sc === 'struct' ||
    tc === 'array' ||
    sc === 'array' ||
    tc === 'fb' ||
    sc === 'fb'
  ) {
    if (sameStructure(target, source)) return undefined;
    return {
      rule: 'possible-type-mismatch',
      severity: 'warning',
      message: `${sn} and ${tn} are different types (not yet verified against TIA).`,
    };
  }
  const widening =
    (sc === tc &&
      (sc === 'int' || sc === 'bit' || sc === 'real') &&
      bitsOf(target) >= bitsOf(source) &&
      signCompatible(target, source)) ||
    (sc === 'char' && tc === 'char' && bitsOf(target) >= bitsOf(source));
  if (widening) return undefined;

  const lossy =
    (sc === 'int' && tc === 'int') ||
    (sc === 'bit' && tc === 'int') ||
    (sc === 'int' && tc === 'bit') ||
    (sc === 'bit' && tc === 'bit') ||
    (sc === 'real' && tc === 'int') ||
    (sc === 'real' && tc === 'real');
  if (iecCheck && lossy && sc !== 'real') {
    // corpus C10/B08: Word→Int, Int→SInt, DInt→Int, Int→Word are errors with the IEC check
    return {
      rule: 'iec-implicit-conversion',
      severity: 'error',
      message: `With the IEC check on, ${sn} is not converted implicitly into ${tn}; use an explicit conversion.`,
    };
  }
  if (lossy) {
    // corpus C10/B07: TIA accepts these without the IEC check and warns
    return {
      rule: 'implicit-conversion',
      severity: 'warning',
      message: `Implicit conversion from ${sn} to ${tn} may lose sign or precision.`,
    };
  }
  return undefined;
}

function signCompatible(target: DataType, source: DataType): boolean {
  if (target.kind !== 'elementary' || source.kind !== 'elementary' || target.info.class !== 'int')
    return true;
  const ts = target.info.signed ?? true;
  const ss = source.info.signed ?? true;
  if (ts === ss) return true;
  // unsigned into a strictly wider signed type keeps every value
  return ts && !ss && target.info.bits > source.info.bits;
}

function sameStructure(a: DataType, b: DataType): boolean {
  if (a.kind === 'udt' && b.kind === 'udt') return a.block.id === b.block.id;
  if (a.kind === 'fb' && b.kind === 'fb') return a.block.id === b.block.id;
  if (a.kind === 'system' && b.kind === 'system') return a.type.name === b.type.name;
  if (a.kind === 'array' && b.kind === 'array') {
    if (a.star || b.star) return true;
    return (
      a.dimensions.length === b.dimensions.length &&
      sameStructure(a.element, b.element) &&
      a.dimensions.every(
        (d, i) => d.lower === b.dimensions[i]!.lower && d.upper === b.dimensions[i]!.upper,
      )
    );
  }
  if (a.kind === 'elementary' && b.kind === 'elementary') return a.info.name === b.info.name;
  // anonymous structs and mixed forms: cannot tell
  return a.kind === 'struct' || b.kind === 'struct';
}

/** Value range check for integer literals (corpus B15: Int start value 40000). */
export function integerOutOfRange(t: DataType, value: bigint): boolean {
  if (
    t.kind !== 'elementary' ||
    t.info.class !== 'int' ||
    t.info.min === undefined ||
    t.info.max === undefined
  )
    return false;
  return value < BigInt(t.info.min) || value > BigInt(t.info.max);
}

/** Integer value of a literal, or undefined when it is not a plain integer literal. */
export function integerLiteralValue(e: Expression): bigint | undefined {
  if (e.kind === 'unary' && e.op === '-') {
    const inner = integerLiteralValue(e.operand);
    return inner === undefined ? undefined : -inner;
  }
  if (e.kind !== 'literal' || e.literalKind !== 'int') return undefined;
  const text = e.text.replace(/_/g, '');
  const based = /^(\d+)#([0-9A-Fa-f]+)$/.exec(text);
  try {
    if (based) {
      const base = Number(based[1]);
      if (base === 16) return BigInt('0x' + based[2]);
      if (base === 2) return BigInt('0b' + based[2]);
      if (base === 8) return BigInt('0o' + based[2]);
      return undefined;
    }
    if (/^\d+$/.test(text)) return BigInt(text);
  } catch {
    return undefined;
  }
  return undefined;
}
