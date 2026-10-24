// Syntax tree shared by SIMATIC SD documents and external sources. Every node keeps the exact
// range of text it came from; edits are made on those ranges (ADR 0004).
import type { Range } from '../text/source-text.ts';
import type { SourceText } from '../text/source-text.ts';
import type { Token } from './lexer.ts';

export interface Node {
  readonly range: Range;
}

/** An identifier as written, without quotes or '#'. */
export interface Name extends Node {
  readonly text: string;
  readonly quoted: boolean;
}

export interface Attribute extends Node {
  readonly name: string;
  readonly value: string;
  readonly nameRange: Range;
  readonly valueRange: Range;
}

export interface AttributeBlock extends Node {
  readonly attributes: Attribute[];
}

// --- Types ---------------------------------------------------------------------------------

export type TypeNode = NamedType | StringType | ArrayType | StructType | RefType | ErrorType;

/** Int, TON_TIME, "UDT_Motor", _.Filling.FB_Filler, Filling.FB_Filler */
export interface NamedType extends Node {
  readonly kind: 'named';
  readonly path: Name[];
  /** Written from the root: _.Ns.Name */
  readonly rooted: boolean;
}

export interface StringType extends Node {
  readonly kind: 'string';
  readonly wide: boolean;
  readonly length: Expression | undefined;
}

export interface ArrayDimension extends Node {
  readonly lower: Expression | undefined;
  readonly upper: Expression | undefined;
  /** Array[*] */
  readonly star: boolean;
}

export interface ArrayType extends Node {
  readonly kind: 'array';
  readonly dimensions: ArrayDimension[];
  readonly element: TypeNode;
}

export interface StructType extends Node {
  readonly kind: 'struct';
  readonly members: Member[];
}

export interface RefType extends Node {
  readonly kind: 'ref';
  readonly target: TypeNode;
}

export interface ErrorType extends Node {
  readonly kind: 'error';
}

// --- Expressions ----------------------------------------------------------------------------

export type Expression =
  | Literal
  | LocalRef
  | GlobalRef
  | NameRef
  | MemberAccess
  | IndexAccess
  | Deref
  | CallExpression
  | Unary
  | Binary
  | Paren
  | ArrayLiteral
  | StructLiteral
  | AddressRef
  | ErrorExpression;

export type LiteralKind = 'int' | 'real' | 'bool' | 'string' | 'typed' | 'null';

export interface Literal extends Node {
  readonly kind: 'literal';
  readonly literalKind: LiteralKind;
  readonly text: string;
  /** For typed literals: the part before '#', upper case (T, LT, INT, 16, WSTRING ...). */
  readonly prefix: string | undefined;
}

/** #Name */
export interface LocalRef extends Node {
  readonly kind: 'local';
  readonly name: Name;
}

/** "Name" */
export interface GlobalRef extends Node {
  readonly kind: 'global';
  readonly name: Name;
}

/** A bare identifier: ENO, an instruction name, a type name in a CASE label, _ (root). */
export interface NameRef extends Node {
  readonly kind: 'name';
  readonly name: Name;
}

export interface MemberAccess extends Node {
  readonly kind: 'member';
  readonly object: Expression;
  readonly member: Name;
}

export interface IndexAccess extends Node {
  readonly kind: 'index';
  readonly object: Expression;
  readonly indexes: Expression[];
}

/** ref^ */
export interface Deref extends Node {
  readonly kind: 'deref';
  readonly object: Expression;
}

export interface Argument extends Node {
  readonly name: Name | undefined;
  /** ':=' input or InOut, '=>' output, or a non-formal (positional) value. */
  readonly direction: 'in' | 'out' | 'positional';
  readonly value: Expression;
}

export interface CallExpression extends Node {
  readonly kind: 'call';
  readonly callee: Expression;
  readonly args: Argument[];
  readonly argsRange: Range;
}

export interface Unary extends Node {
  readonly kind: 'unary';
  readonly op: 'NOT' | '-' | '+';
  readonly operand: Expression;
}

export type BinaryOperator =
  | '**'
  | '*'
  | '/'
  | 'MOD'
  | '+'
  | '-'
  | '<'
  | '>'
  | '<='
  | '>='
  | '='
  | '<>'
  | 'AND'
  | 'XOR'
  | 'OR';

export interface Binary extends Node {
  readonly kind: 'binary';
  readonly op: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
}

export interface Paren extends Node {
  readonly kind: 'paren';
  readonly inner: Expression;
}

/** [1, 2, 3(0)] in start values */
export interface ArrayLiteral extends Node {
  readonly kind: 'arrayLiteral';
  readonly items: Expression[];
}

/**
 * ((), (), [1.0, 2.0, 8(0.5)], (), ()): the start values of a structured member, one position per
 * member, () where it has none. External sources write it for a member whose PLC data type has
 * start values (corpus B32, FC_V_E07.scl).
 */
export interface StructLiteral extends Node {
  readonly kind: 'structLiteral';
  readonly items: Expression[];
}

/** %I0.0 */
export interface AddressRef extends Node {
  readonly kind: 'address';
  readonly text: string;
}

export interface ErrorExpression extends Node {
  readonly kind: 'error';
}

// --- Statements -----------------------------------------------------------------------------

export type Statement =
  | Assignment
  | CallStatement
  | IfStatement
  | CaseStatement
  | ForStatement
  | WhileStatement
  | RepeatStatement
  | SimpleStatement
  | GotoStatement
  | LabelStatement
  | RegionStatement
  | NotAnalyzedStatement;

export type AssignOperator = ':=' | '+=' | '-=' | '*=' | '/=';

export interface Assignment extends Node {
  readonly kind: 'assign';
  readonly target: Expression;
  readonly op: AssignOperator;
  readonly value: Expression;
}

export interface CallStatement extends Node {
  readonly kind: 'callStatement';
  readonly call: CallExpression;
}

export interface ConditionalBranch extends Node {
  readonly condition: Expression;
  readonly body: Statement[];
}

export interface IfStatement extends Node {
  readonly kind: 'if';
  readonly branches: ConditionalBranch[];
  readonly elseBody: Statement[] | undefined;
}

export interface CaseLabel extends Node {
  readonly from: Expression;
  readonly to: Expression | undefined;
}

export interface CaseClause extends Node {
  readonly labels: CaseLabel[];
  readonly body: Statement[];
}

export interface CaseStatement extends Node {
  readonly kind: 'case';
  readonly selector: Expression;
  readonly clauses: CaseClause[];
  readonly elseBody: Statement[] | undefined;
}

export interface ForStatement extends Node {
  readonly kind: 'for';
  readonly variable: Expression;
  readonly from: Expression;
  readonly to: Expression;
  readonly by: Expression | undefined;
  readonly body: Statement[];
}

export interface WhileStatement extends Node {
  readonly kind: 'while';
  readonly condition: Expression;
  readonly body: Statement[];
}

export interface RepeatStatement extends Node {
  readonly kind: 'repeat';
  readonly body: Statement[];
  readonly condition: Expression;
}

export interface SimpleStatement extends Node {
  readonly kind: 'exit' | 'continue' | 'return' | 'empty';
}

export interface GotoStatement extends Node {
  readonly kind: 'goto';
  readonly label: Name;
}

export interface LabelStatement extends Node {
  readonly kind: 'label';
  readonly label: Name;
}

export interface RegionStatement extends Node {
  readonly kind: 'region';
  readonly title: string;
  readonly titleRange: Range;
  readonly body: Statement[];
}

export interface NotAnalyzedStatement extends Node {
  readonly kind: 'notAnalyzed';
}

// --- Declarations ---------------------------------------------------------------------------

export type SectionKind = 'Input' | 'Output' | 'InOut' | 'Static' | 'Temp' | 'Constant';

export interface Member extends Node {
  readonly name: Name;
  readonly type: TypeNode;
  readonly initial: Expression | undefined;
  readonly attributes: Attribute[];
  readonly attributeBlock: AttributeBlock | undefined;
  /** AT overlay target (external sources only; SIMATIC SD drops it). */
  readonly at: Name | undefined;
  /** Trailing // comment of an external source. */
  readonly comment: { readonly text: string; readonly range: Range } | undefined;
}

export interface VarSection extends Node {
  readonly kind: SectionKind;
  readonly keyword: string;
  /** RETAIN, NON_RETAIN, CONSTANT, DB_SPECIFIC */
  readonly modifiers: string[];
  readonly members: Member[];
  readonly headerRange: Range;
}

// --- LAD / FBD ------------------------------------------------------------------------------

export type RungStart =
  | { readonly kind: 'powerrail'; readonly range: Range }
  | { readonly kind: 'wire'; readonly name: string; readonly range: Range }
  | { readonly kind: 'operand'; readonly operand: Expression; readonly range: Range }
  | { readonly kind: 'none'; readonly range: Range };

export interface LadderElement extends Node {
  readonly kind: 'element';
  /** NOT A(...), NOT JumpCoil(...) */
  readonly negated: boolean;
  /** Contact, Coil, Move, #Inst, "FC_X", #Delay.TON ... */
  readonly callee: Expression;
  /** Instruction name as written (Contact, TON, FC_X, Inst). */
  readonly instruction: string;
  readonly templates: Attribute[];
  readonly args: Argument[];
}

export interface Junction extends Node {
  readonly kind: 'junction';
  readonly name: string;
}

export type RungItem = LadderElement | Junction;

export interface Rung extends Node {
  readonly start: RungStart;
  readonly items: RungItem[];
  /** END_RUNG wire#w1: the rung ends at a named wire. */
  readonly end: { readonly name: string; readonly range: Range } | undefined;
}

export interface LadderLabel extends Node {
  readonly name: Name;
}

export interface LadderBody {
  readonly labels: LadderLabel[];
  readonly rungs: Rung[];
}

// --- Blocks ---------------------------------------------------------------------------------

export type NetworkLanguage = 'SCL' | 'LAD' | 'FBD' | 'unknown';

export interface Network extends Node {
  /** 1-based position in the block (TIA's "Network n"). */
  readonly index: number;
  readonly language: NetworkLanguage;
  readonly attributeBlock: AttributeBlock | undefined;
  readonly titleId: string | undefined;
  readonly commentId: string | undefined;
  readonly keywordRange: Range;
  readonly bodyRange: Range;
  readonly statements: Statement[] | undefined;
  readonly ladder: LadderBody | undefined;
}

export type BlockKind = 'OB' | 'FB' | 'FC' | 'DB' | 'UDT';

export interface Block extends Node {
  readonly kind: BlockKind;
  readonly name: Name;
  readonly namespace: string | undefined;
  /** Header attributes (SIMATIC SD) or the { } block of an external source. */
  readonly attributes: Attribute[];
  readonly attributeBlock: AttributeBlock | undefined;
  readonly returnType: TypeNode | undefined;
  /** Instance DB: the FB (or system FB) type; array DB: the array type. */
  readonly dbType: TypeNode | undefined;
  readonly title: { readonly text: string; readonly range: Range } | undefined;
  readonly version: string | undefined;
  readonly sections: VarSection[];
  /** UDT body. */
  readonly struct: StructType | undefined;
  readonly networks: Network[];
  /** DB start values, and instance-DB start values. */
  readonly startValues: Assignment[];
  /** Offset where the code part begins (first network or BEGIN). */
  readonly codeStart: number;
}

export type Severity = 'error' | 'warning' | 'info';

export interface SyntaxDiagnostic {
  readonly range: Range;
  readonly message: string;
  readonly severity: Severity;
  readonly code: string;
}

export type BlockFileFormat = 's7dcl' | 'source';

export interface BlockFile {
  readonly kind: 'blocks';
  readonly format: BlockFileFormat;
  readonly source: SourceText;
  readonly tokens: Token[];
  readonly blocks: Block[];
  readonly namespace: { readonly name: string; readonly range: Range } | undefined;
  readonly diagnostics: SyntaxDiagnostic[];
  /** Ranges kept as they are, marked "not analyzed". */
  readonly notAnalyzed: Range[];
}
