// Binds every name in a block to its declaration, infers expression types, records references and
// call sites, and reports the checker's diagnostics (spec M2/M3). Precision before recall: when
// something cannot be decided the binder stays silent or warns (ADR 0003).
import type { Instruction, Parameter, ProfileIndex } from '@plcstudio/profiles';
import type {
  Argument,
  Block,
  CallExpression,
  Expression,
  LadderElement,
  Member,
  Network,
  Statement,
  TypeNode,
} from '../syntax/ast.ts';
import type { Range } from '../text/source-text.ts';
import {
  blockId,
  memberId,
  systemMember,
  type BlockSymbol,
  type LocatedDiagnostic,
  type ProjectIndex,
  type TagSymbol,
  type UnitInfo,
} from '../model/project.ts';
import {
  classOf,
  conversionProblem,
  fitsGeneric,
  integerLiteralValue,
  integerOutOfRange,
  isUnknown,
  membersOf,
  typeName,
  UNKNOWN,
  type DataType,
  type MemberInfo,
} from '../model/types.ts';
import { ruleInfo } from './rules.ts';

export type Access = 'read' | 'write' | 'readwrite' | 'call' | 'declaration' | 'type';
export type SymbolKind = 'block' | 'member' | 'tag' | 'constant' | 'label' | 'instruction';

export interface Reference {
  readonly file: string;
  readonly range: Range;
  readonly symbolId: string;
  readonly symbolKind: SymbolKind;
  readonly access: Access;
  /** Block that contains the reference. */
  readonly blockId: string;
}

export interface CallArgument {
  readonly parameter: string | undefined;
  readonly direction: 'in' | 'out' | 'positional';
  readonly value: Expression;
}

export interface CallSite {
  readonly callerId: string;
  readonly file: string;
  readonly range: Range;
  /** Block id, or instruction:NAME for system instructions; undefined when unresolved. */
  readonly calleeId: string | undefined;
  readonly calleeName: string;
  readonly kind: 'fb' | 'fc' | 'instruction' | 'unresolved';
  readonly instance:
    | {
        readonly kind: 'single' | 'multi' | 'parameter' | 'system';
        readonly id: string;
        readonly name: string;
      }
    | undefined;
  readonly conditional: boolean;
  readonly conditions: readonly string[];
  readonly inLoop: boolean;
  /** LAD/FBD: the box sits behind other elements (called through EN). */
  readonly viaEn: boolean;
  readonly network: number | undefined;
  readonly args: readonly CallArgument[];
  /** Instruction name for instance calls of system FBs (TON for a TON_TIME instance). */
  readonly instruction: string | undefined;
}

export interface BlockAnalysis {
  readonly symbol: BlockSymbol;
  readonly references: Reference[];
  readonly calls: CallSite[];
  readonly diagnostics: LocatedDiagnostic[];
}

interface Context {
  readonly conditions: readonly string[];
  readonly loopDepth: number;
  readonly forCounters: readonly { readonly id: string; readonly range: Range }[];
  readonly network: number | undefined;
  readonly viaEn: boolean;
}

const ROOT_CONTEXT: Context = {
  conditions: [],
  loopDepth: 0,
  forCounters: [],
  network: undefined,
  viaEn: false,
};

/** Interface types not permitted in fail-safe blocks (corpus B23: Real). */
const F_FORBIDDEN = new Set([
  'REAL',
  'LREAL',
  'STRING',
  'WSTRING',
  'CHAR',
  'WCHAR',
  'LINT',
  'ULINT',
  'LWORD',
  'LTIME',
  'VARIANT',
  'DTL',
  'LDT',
]);
const F_ALLOWED = new Set(['BOOL', 'INT', 'DINT', 'WORD', 'TIME']);

export class BlockBinder {
  private readonly index: ProjectIndex;
  private readonly symbol: BlockSymbol;
  private readonly profile: ProfileIndex;
  private readonly file: string;
  private readonly references: Reference[] = [];
  private readonly calls: CallSite[] = [];
  private readonly diagnostics: LocatedDiagnostic[] = [];
  private readonly scope = new Map<string, MemberInfo>();
  private readonly labels = new Set<string>();

  constructor(index: ProjectIndex, symbol: BlockSymbol) {
    this.index = index;
    this.symbol = symbol;
    this.profile = index.project.profile;
    this.file = symbol.file.path;
  }

  run(): BlockAnalysis {
    const block = this.symbol.block;
    const members =
      this.symbol.kind === 'DB'
        ? this.index.dbMembers(this.symbol)
        : this.index.interfaceMembers(this.symbol);
    for (const m of members)
      if (!this.scope.has(m.name.toLowerCase())) this.scope.set(m.name.toLowerCase(), m);
    this.reference(block.name.range, this.symbol.id, 'block', 'declaration');
    this.checkIdentifier(block.name.text, block.name.range, block.name.quoted);
    this.declarations(block);
    for (const network of block.networks) this.collectLabels(network);
    for (const network of block.networks) {
      const ctx = {
        ...ROOT_CONTEXT,
        network: block.networks.length > 1 || network.ladder ? network.index : undefined,
      };
      if (network.statements) this.statements(network.statements, ctx);
      if (network.ladder) this.ladder(network, ctx);
    }
    for (const sv of block.startValues) this.startValue(sv.target, sv.value);
    if (this.symbol.incomplete) this.downgrade();
    return {
      symbol: this.symbol,
      references: this.references,
      calls: this.calls,
      diagnostics: this.diagnostics,
    };
  }

  // --- Reporting -----------------------------------------------------------------------------

  private report(
    range: Range,
    rule: string,
    message: string,
    severity?: 'error' | 'warning' | 'info',
  ): void {
    const info = ruleInfo(rule);
    this.diagnostics.push({
      file: this.file,
      range,
      code: rule,
      message,
      severity: severity ?? info?.severity ?? 'warning',
    });
  }

  /** Errors in a block with not-analyzed text could be caused by what was not analyzed. */
  private downgrade(): void {
    for (let i = 0; i < this.diagnostics.length; i++) {
      const d = this.diagnostics[i]!;
      if (d.severity === 'error' && ruleInfo(d.code)?.category !== 'policy') {
        this.diagnostics[i] = {
          ...d,
          severity: 'warning',
          message: `${d.message} (Part of this block was not analyzed.)`,
        };
      }
    }
  }

  private reference(range: Range, symbolId: string, symbolKind: SymbolKind, access: Access): void {
    this.references.push({
      file: this.file,
      range,
      symbolId,
      symbolKind,
      access,
      blockId: this.symbol.id,
    });
  }

  // --- Declarations --------------------------------------------------------------------------

  private declarations(block: Block): void {
    const memberLists: { members: readonly Member[]; ownerId: string }[] = block.sections.map(
      (s) => ({ members: s.members, ownerId: this.symbol.id }),
    );
    if (block.struct) memberLists.push({ members: block.struct.members, ownerId: this.symbol.id });
    // one interface: names must be unique across all sections
    const all = block.sections.flatMap((s) => s.members);
    this.uniqueNames(block.struct ? block.struct.members : all);
    for (const { members, ownerId } of memberLists) this.declareMembers(members, ownerId);
    if (block.returnType) this.typeReferences(block.returnType);
    if (block.dbType) this.typeReferences(block.dbType);
    if (this.symbol.failsafe) this.failsafeInterface(block);
    else this.failsafeUnknown(block);
    this.cpuFamilyOfDeclarations(block);
  }

  /**
   * External sources carry no fail-safe marker (format-notes, finding 2): in a fail-safe PLC a DB
   * source could be an F-DB. It is treated as standard and flagged (spec, "Fail-safe blocks").
   */
  private failsafeUnknown(block: Block): void {
    if (
      block.kind !== 'DB' ||
      this.symbol.file.parsed?.kind !== 'blocks' ||
      this.symbol.file.parsed.format !== 'source'
    )
      return;
    if (!this.index.project.manifest?.cpu.failsafe) return;
    this.report(
      block.name.range,
      'failsafe-unknown',
      `An external source does not say whether ${block.name.text} is a fail-safe DB; it is treated as standard. List it under "failsafeBlocks" in plc.json if it is one.`,
    );
  }

  private declareMembers(members: readonly Member[], ownerId: string): void {
    for (const m of members) {
      const id = memberId(ownerId, m.name.text);
      this.reference(m.name.range, id, 'member', 'declaration');
      this.checkIdentifier(m.name.text, m.name.range, m.name.quoted);
      this.typeReferences(m.type);
      if (m.initial) {
        const t = this.index.resolveType(m.type, this.symbol.namespace, ownerId, this.file);
        this.checkStartValue(t, m.initial);
      }
      if (m.type.kind === 'struct') {
        this.uniqueNames(m.type.members);
        this.declareMembers(m.type.members, id);
      }
    }
  }

  private uniqueNames(members: readonly Member[]): void {
    const seen = new Map<string, Member>();
    for (const m of members) {
      const k = m.name.text.toLowerCase();
      const first = seen.get(k);
      if (!first) {
        seen.set(k, m);
        continue;
      }
      if (first.name.text === m.name.text) {
        this.report(
          m.name.range,
          'duplicate-name',
          `${m.name.text} is declared twice in this interface.`,
        );
      } else {
        this.report(
          m.name.range,
          'case-only-duplicate',
          `${m.name.text} and ${first.name.text} differ only by case; PLC Studio does not allow that (TIA renames or refuses one of them).`,
        );
      }
    }
  }

  private checkIdentifier(name: string, range: Range, quoted: boolean): void {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.includes('.')) return;
    if (quoted || /\s/.test(name) || [...name].some((c) => c.charCodeAt(0) > 127)) {
      this.report(
        range,
        'invalid-identifier',
        `${name} contains spaces or language-specific characters; TIA accepts it in quotes, but it has to be quoted everywhere.`,
      );
    }
  }

  /** References to UDTs and FBs used as types, with the unit access rules. */
  private typeReferences(node: TypeNode): void {
    switch (node.kind) {
      case 'array':
        this.typeReferences(node.element);
        return;
      case 'ref':
        this.typeReferences(node.target);
        return;
      case 'named': {
        const t = this.index.resolveType(node, this.symbol.namespace, this.symbol.id, this.file);
        if (t.kind === 'udt' || t.kind === 'fb') {
          const target = this.index.block(t.block.id);
          if (target) {
            this.reference(node.path[node.path.length - 1]!.range, target.id, 'block', 'type');
            this.unitAccess(
              target.unit,
              target.published ?? publishedByManifest(target.unit, target.name),
              target.name,
              node.range,
            );
          }
        } else if (
          t.kind === 'unknown' &&
          (node.rooted || node.path.length > 1 || node.path[0]!.quoted)
        ) {
          this.report(
            node.range,
            'unknown-global',
            `The type ${node.path.map((p) => p.text).join('.')} is not in the exported files.`,
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private failsafeInterface(block: Block): void {
    for (const section of block.sections) {
      for (const m of section.members) {
        if (m.type.kind !== 'named' || m.type.path.length !== 1) continue;
        const n = m.type.path[0]!.text.toUpperCase();
        if (F_FORBIDDEN.has(n)) {
          this.report(
            m.type.range,
            'failsafe-type',
            `${m.type.path[0]!.text} is not permitted in the interface of a fail-safe block.`,
          );
        } else if (!F_ALLOWED.has(n) && this.profile.elementary(n)) {
          this.report(
            m.type.range,
            'failsafe-type',
            `${m.type.path[0]!.text} may not be permitted in a fail-safe block (not yet verified against TIA).`,
            'warning',
          );
        }
      }
    }
  }

  private cpuFamilyOfDeclarations(block: Block): void {
    const family = this.index.project.cpuFamily;
    if (!family) return;
    const visit = (node: TypeNode) => {
      if (node.kind === 'named' && node.path.length === 1) {
        const t = this.profile.elementary(node.path[0]!.text);
        if (t && !t.cpuFamilies.includes(family)) {
          this.report(node.range, 'not-available-on-cpu', `${t.name} does not exist on ${family}.`);
        }
      } else if (node.kind === 'array') visit(node.element);
      else if (node.kind === 'struct') node.members.forEach((m) => visit(m.type));
    };
    for (const s of block.sections) for (const m of s.members) visit(m.type);
    if (block.struct) block.struct.members.forEach((m) => visit(m.type));
  }

  // --- Unit access ---------------------------------------------------------------------------

  private unitAccess(
    target: UnitInfo | undefined,
    published: boolean | undefined,
    name: string,
    range: Range,
  ): void {
    const from = this.symbol.unit;
    if (!from || !target || from.name === target.name) return;
    if (published === false) {
      this.report(
        range,
        'unpublished-access',
        `${target.namespace}.${name} is not published, so unit ${from.name} cannot use it.`,
      );
    }
    if (!from.relations.includes(target.name)) {
      this.report(
        range,
        'missing-relation',
        `Unit ${from.name} has no relation to unit ${target.name}; add one in plc.json and in TIA.`,
      );
    }
  }

  // --- Statements ----------------------------------------------------------------------------

  private collectLabels(network: Network): void {
    for (const l of network.ladder?.labels ?? []) this.labels.add(l.name.text.toLowerCase());
    const walk = (list: readonly Statement[]) => {
      for (const s of list) {
        if (s.kind === 'label') this.labels.add(s.label.text.toLowerCase());
        for (const child of childStatements(s)) walk(child);
      }
    };
    if (network.statements) walk(network.statements);
  }

  private statements(list: readonly Statement[], ctx: Context): void {
    for (const s of list) this.statement(s, ctx);
  }

  private conditionText(e: Expression): string {
    return this.symbol.file.source.text.slice(e.range.start, e.range.end);
  }

  private statement(s: Statement, ctx: Context): void {
    switch (s.kind) {
      case 'assign': {
        const target = this.expression(s.target, ctx, s.op === ':=' ? 'write' : 'readwrite');
        const value = this.expression(s.value, ctx, 'read');
        this.assignmentTarget(s.target, ctx);
        this.checkAssignment(target, value, s.value);
        return;
      }
      case 'callStatement':
        this.expression(s.call, ctx, 'call');
        return;
      case 'if': {
        let conditions = ctx.conditions;
        for (const b of s.branches) {
          this.expression(b.condition, ctx, 'read');
          const text = this.conditionText(b.condition);
          this.statements(b.body, { ...ctx, conditions: [...conditions, text] });
          conditions = [...conditions, `NOT (${text})`];
        }
        if (s.elseBody) this.statements(s.elseBody, { ...ctx, conditions: [...conditions] });
        return;
      }
      case 'case': {
        this.expression(s.selector, ctx, 'read');
        const selector = this.conditionText(s.selector);
        const seen = new Map<string, Range>();
        for (const clause of s.clauses) {
          for (const label of clause.labels) {
            const text = this.symbol.file.source.text
              .slice(label.range.start, label.range.end)
              .replace(/\s+/g, '')
              .toUpperCase();
            if (seen.has(text))
              this.report(
                label.range,
                'duplicate-case-label',
                `The CASE label ${text} is used twice; only the first branch runs.`,
              );
            else seen.set(text, label.range);
            this.caseLabel(label.from, ctx);
            if (label.to) this.caseLabel(label.to, ctx);
          }
          const labelText = clause.labels
            .map((l) => this.symbol.file.source.text.slice(l.range.start, l.range.end))
            .join(', ');
          this.statements(clause.body, {
            ...ctx,
            conditions: [...ctx.conditions, `${selector} = ${labelText}`],
          });
        }
        if (s.elseBody)
          this.statements(s.elseBody, {
            ...ctx,
            conditions: [...ctx.conditions, `${selector} (ELSE)`],
          });
        return;
      }
      case 'for': {
        const counterType = this.expression(s.variable, ctx, 'write');
        const counterClass = classOf(counterType);
        if (!isUnknown(counterType) && counterClass !== 'int') {
          this.report(
            s.variable.range,
            'for-counter-type',
            `The FOR counter must be an integer; ${typeName(counterType)} is not allowed.`,
          );
        }
        this.expression(s.from, ctx, 'read');
        this.expression(s.to, ctx, 'read');
        if (s.by) this.expression(s.by, ctx, 'read');
        const counter = this.symbolOf(s.variable);
        this.statements(s.body, {
          ...ctx,
          loopDepth: ctx.loopDepth + 1,
          forCounters: counter
            ? [...ctx.forCounters, { id: counter, range: s.variable.range }]
            : ctx.forCounters,
        });
        return;
      }
      case 'while':
        this.expression(s.condition, ctx, 'read');
        this.statements(s.body, {
          ...ctx,
          loopDepth: ctx.loopDepth + 1,
          conditions: [...ctx.conditions, this.conditionText(s.condition)],
        });
        return;
      case 'repeat':
        this.statements(s.body, { ...ctx, loopDepth: ctx.loopDepth + 1 });
        this.expression(s.condition, ctx, 'read');
        return;
      case 'region':
        this.statements(s.body, ctx);
        return;
      case 'goto':
        if (!this.labels.has(s.label.text.toLowerCase())) {
          this.report(
            s.label.range,
            'unknown-label',
            `The jump label ${s.label.text} does not exist in this block.`,
          );
        } else {
          this.reference(
            s.label.range,
            `label:${this.symbol.id}/${s.label.text.toLowerCase()}`,
            'label',
            'read',
          );
        }
        return;
      case 'label':
        this.reference(
          s.label.range,
          `label:${this.symbol.id}/${s.label.text.toLowerCase()}`,
          'label',
          'declaration',
        );
        return;
      default:
        return;
    }
  }

  /** CASE labels are constants or, after TypeOf, data type names. */
  private caseLabel(e: Expression, ctx: Context): void {
    if (e.kind === 'name') return;
    if (
      e.kind === 'global' &&
      this.index.findBlock(e.name.text, this.symbol.namespace)?.kind === 'UDT'
    )
      return;
    this.expression(e, ctx, 'read');
  }

  /** The symbol id an expression denotes, when it is a plain variable. */
  private symbolOf(e: Expression): string | undefined {
    if (e.kind === 'local') return this.scope.get(e.name.text.toLowerCase())?.id;
    return undefined;
  }

  private assignmentTarget(target: Expression, ctx: Context): void {
    const id = this.symbolOf(target);
    const loop = id ? ctx.forCounters.find((c) => c.id === id) : undefined;
    if (loop) {
      // TIA reports this at the FOR statement (corpus B26)
      const line = this.symbol.file.source.positionAt(target.range.start).line + 1;
      this.report(
        loop.range,
        'for-counter-modified',
        `The FOR counter ${this.conditionText(target)} is changed inside the loop (line ${line}); that is not allowed.`,
      );
    }
    if (target.kind === 'local') {
      const m = this.scope.get(target.name.text.toLowerCase());
      if (m?.section === 'Constant')
        this.report(
          target.range,
          'assign-to-constant',
          `${m.name} is a constant and cannot be assigned.`,
        );
    }
    if (target.kind === 'global') {
      const tag = this.index.findTag(target.name.text);
      if (
        tag &&
        tag.kind !== 'tag' &&
        !this.index.findBlock(target.name.text, this.symbol.namespace)
      ) {
        this.report(
          target.range,
          'assign-to-constant',
          `${tag.name} is a constant and cannot be assigned.`,
        );
      }
    }
  }

  private checkAssignment(target: DataType, value: DataType, valueExpression: Expression): void {
    const problem = conversionProblem(target, value, this.symbol.iecCheck, valueExpression);
    if (problem)
      this.report(valueExpression.range, problem.rule, problem.message, problem.severity);
    this.checkRange(target, valueExpression);
  }

  private checkRange(target: DataType, e: Expression): void {
    const v = integerLiteralValue(e);
    if (v !== undefined && integerOutOfRange(target, v)) {
      this.report(
        e.range,
        'value-out-of-range',
        `${v} is outside the range of ${typeName(target)}.`,
      );
    }
  }

  private checkStartValue(t: DataType, e: Expression): void {
    this.checkRange(t, e);
    if (e.kind !== 'arrayLiteral') {
      const value = this.expression(e, ROOT_CONTEXT, 'read');
      const problem = conversionProblem(t, value, this.symbol.iecCheck, e);
      if (problem && problem.severity === 'error')
        this.report(e.range, problem.rule, problem.message, problem.severity);
    }
  }

  private startValue(target: Expression, value: Expression): void {
    const t = this.expression(target, ROOT_CONTEXT, 'write', true);
    this.checkStartValue(t, value);
  }

  // --- Expressions -------------------------------------------------------------------------

  private literalType(e: Expression & { kind: 'literal' }): DataType {
    switch (e.literalKind) {
      case 'bool':
        return elementary(this.profile, 'Bool');
      case 'int':
        return { kind: 'generic', name: 'INT_LITERAL' };
      case 'real':
        return { kind: 'generic', name: 'REAL_LITERAL' };
      case 'string':
        return { kind: 'generic', name: 'STRING_LITERAL' };
      case 'null':
        return UNKNOWN;
      case 'typed': {
        const info = this.profile.literalType(e.prefix ?? '');
        if (!info) return UNKNOWN;
        const family = this.index.project.cpuFamily;
        if (family && !info.cpuFamilies.includes(family)) {
          this.report(
            e.range,
            'not-available-on-cpu',
            `${info.name} values (${e.prefix}#) do not exist on ${family}.`,
          );
        }
        return { kind: 'elementary', name: info.name, info };
      }
    }
  }

  /**
   * Type of an expression; records references. `dbStart`: bare names are members of the DB
   * (start values).
   */
  private expression(e: Expression, ctx: Context, access: Access, dbStart = false): DataType {
    switch (e.kind) {
      case 'literal':
        return this.literalType(e);
      case 'local':
        return this.local(e, access);
      case 'global':
        return this.global(e.name.text, e.range, access);
      case 'name':
        return this.bareName(e.name.text, e.range, access, dbStart);
      case 'member':
        return this.member(e, ctx, access, dbStart);
      case 'index': {
        const t = this.expression(e.object, ctx, access === 'call' ? 'read' : access, dbStart);
        for (const i of e.indexes) this.expression(i, ctx, 'read');
        return t.kind === 'array' ? t.element : UNKNOWN;
      }
      case 'deref': {
        const t = this.expression(e.object, ctx, 'read');
        return t.kind === 'ref' ? t.target : UNKNOWN;
      }
      case 'call':
        return this.call(e, ctx);
      case 'unary': {
        const t = this.expression(e.operand, ctx, 'read');
        return t;
      }
      case 'binary': {
        const l = this.expression(e.left, ctx, 'read');
        const r = this.expression(e.right, ctx, 'read');
        if (['<', '>', '<=', '>=', '=', '<>'].includes(e.op))
          return elementary(this.profile, 'Bool');
        if (e.op === 'AND' || e.op === 'OR' || e.op === 'XOR')
          return classOf(l) === 'bool' && classOf(r) === 'bool' ? l : isUnknown(l) ? r : l;
        if (isUnknown(l)) return r;
        if (isUnknown(r)) return l;
        return l.kind === 'elementary' && r.kind === 'elementary' && r.info.bits > l.info.bits
          ? r
          : l;
      }
      case 'paren':
        return this.expression(e.inner, ctx, access);
      case 'arrayLiteral':
        for (const item of e.items) this.expression(item, ctx, 'read');
        return UNKNOWN;
      default:
        return UNKNOWN;
    }
  }

  private local(e: Expression & { kind: 'local' }, access: Access): DataType {
    const name = e.name.text;
    const m = this.scope.get(name.toLowerCase());
    if (m) {
      this.reference(e.name.range, m.id, 'member', access);
      return m.type;
    }
    if (this.symbol.kind === 'FC' && name.toLowerCase() === this.symbol.name.toLowerCase()) {
      // the return value of an FC
      this.reference(e.name.range, this.symbol.id, 'block', access);
      return this.index.resolveType(
        this.symbol.block.returnType,
        this.symbol.namespace,
        this.symbol.id,
        this.file,
      );
    }
    if (this.symbol.kind === 'OB') {
      this.report(
        e.range,
        'undeclared-local',
        `#${name} is not declared in this OB's interface; if it is an OB start variable, it is not in the export.`,
        'warning',
      );
    } else {
      this.report(e.range, 'undeclared-local', `#${name} is not declared in the block interface.`);
    }
    return UNKNOWN;
  }

  private global(name: string, range: Range, access: Access): DataType {
    const block = this.index.findBlock(name, this.symbol.namespace);
    if (block) {
      this.reference(range, block.id, 'block', access === 'call' ? 'call' : access);
      this.unitAccess(
        block.unit,
        block.published ?? publishedByManifest(block.unit, block.name),
        block.name,
        range,
      );
      if (block.kind === 'DB') return this.index.dbType(block);
      if (block.kind === 'FB') return this.index.fbType(block);
      return UNKNOWN;
    }
    const tag = this.index.findTag(name);
    if (tag) {
      this.reference(range, tag.id, tag.kind === 'tag' ? 'tag' : 'constant', access);
      this.unitAccess(
        tag.unit,
        tag.table.published ?? publishedByManifest(tag.unit, tag.table.name),
        tag.name,
        range,
      );
      return this.index.tagType(tag);
    }
    if (this.index.project.hasManifest) {
      this.report(range, 'unknown-global', `"${name}" is not in the exported files of this PLC.`);
    }
    return UNKNOWN;
  }

  private bareName(name: string, range: Range, access: Access, dbStart: boolean): DataType {
    const lower = name.toLowerCase();
    if (dbStart) {
      const m = this.scope.get(lower);
      if (m) {
        this.reference(range, m.id, 'member', access);
        return m.type;
      }
      return UNKNOWN;
    }
    if (lower === 'eno' || lower === 'en') return elementary(this.profile, 'Bool');
    // inside a namespace, blocks of the same namespace are written without quotes
    const block = this.index.findBlock(name, this.symbol.namespace);
    if (
      block &&
      (block.namespace ?? '') === (this.symbol.namespace ?? '') &&
      this.symbol.namespace
    ) {
      this.reference(range, block.id, 'block', access);
      return block.kind === 'DB' ? this.index.dbType(block) : UNKNOWN;
    }
    const constant = this.scope.get(lower);
    if (constant?.section === 'Constant') {
      this.reference(range, constant.id, 'member', 'read');
      return constant.type;
    }
    return UNKNOWN;
  }

  /** `_` followed by a member chain: a name from the root, `_.Tag` or `_.Ns.Block`. */
  private rootPath(e: Expression): string[] | undefined {
    if (e.kind === 'name') return e.name.text === '_' ? [] : undefined;
    if (e.kind === 'member') {
      const p = this.rootPath(e.object);
      return p === undefined ? undefined : [...p, e.member.text];
    }
    return undefined;
  }

  private member(
    e: Expression & { kind: 'member' },
    ctx: Context,
    access: Access,
    dbStart: boolean,
  ): DataType {
    const root = this.rootPath(e);
    if (root) {
      const name = root[root.length - 1]!;
      const ns = root.slice(0, -1).join('.');
      const block = this.index.findBlock(name, this.symbol.namespace, ns || null);
      if (block) {
        this.reference(e.member.range, block.id, 'block', access);
        this.unitAccess(
          block.unit,
          block.published ?? publishedByManifest(block.unit, block.name),
          block.name,
          e.range,
        );
        return block.kind === 'DB'
          ? this.index.dbType(block)
          : block.kind === 'FB'
            ? this.index.fbType(block)
            : UNKNOWN;
      }
      if (root.length === 1) {
        const tag = this.index.findTag(name);
        if (tag) {
          this.reference(e.member.range, tag.id, tag.kind === 'tag' ? 'tag' : 'constant', access);
          return this.index.tagType(tag);
        }
      }
      // a namespace prefix on its way to a block: `_.Filling` alone
      if (
        this.index.blocks.some((b) =>
          b.namespace?.toLowerCase().startsWith(root.join('.').toLowerCase()),
        )
      )
        return UNKNOWN;
      if (this.index.project.hasManifest)
        this.report(
          e.range,
          'unknown-global',
          `${['_', ...root].join('.')} is not in the exported files of this PLC.`,
        );
      return UNKNOWN;
    }
    const objectAccess: Access =
      access === 'write' || access === 'readwrite'
        ? 'readwrite'
        : access === 'call'
          ? 'read'
          : access;
    const objectType = this.expression(e.object, ctx, objectAccess, dbStart);
    const memberName = e.member.text;
    if (memberName.startsWith('%')) {
      // slice access: %X0, %B1, %W0, %D0
      const kind = memberName[1]?.toUpperCase();
      return kind === 'X'
        ? elementary(this.profile, 'Bool')
        : kind === 'B'
          ? elementary(this.profile, 'Byte')
          : kind === 'W'
            ? elementary(this.profile, 'Word')
            : kind === 'D'
              ? elementary(this.profile, 'DWord')
              : UNKNOWN;
    }
    if (objectType.kind === 'system') {
      const p = objectType.type.parameters.find(
        (x) => x.name.toLowerCase() === memberName.toLowerCase(),
      );
      const m = objectType.type.members.find(
        (x) => x.name.toLowerCase() === memberName.toLowerCase(),
      );
      const t = p ? this.paramType(p) : m ? this.typeByName(m.type) : undefined;
      if (t) return t;
      return UNKNOWN;
    }
    const members = membersOf(objectType);
    if (!members) return UNKNOWN;
    const m = members.find((x) => x.name.toLowerCase() === memberName.toLowerCase());
    if (m) {
      this.reference(e.member.range, m.id, 'member', access === 'call' ? 'read' : access);
      return m.type;
    }
    const owner =
      objectType.kind === 'udt' || objectType.kind === 'fb'
        ? this.index.block(objectType.block.id)
        : undefined;
    if (!owner?.incomplete && objectType.kind !== 'struct') {
      this.report(
        e.member.range,
        'unknown-member',
        `${typeName(objectType)} has no member ${memberName}.`,
      );
    }
    return UNKNOWN;
  }

  private typeByName(name: string): DataType {
    const t = this.profile.elementary(name);
    if (t) return { kind: 'elementary', name: t.name, info: t };
    const s = this.profile.systemType(name);
    if (s) return { kind: 'system', type: s };
    return { kind: 'generic', name };
  }

  private paramType(p: Parameter): DataType {
    return this.typeByName(p.type);
  }

  // --- Calls -----------------------------------------------------------------------------------

  private call(e: CallExpression, ctx: Context): DataType {
    const callee = e.callee;
    // #Instance(...) / #Instance.TON(...) / "IDB"(...) / "FC"(...) / _.Ns.FC(...) / NAME(...)
    if (callee.kind === 'local') {
      const m = this.scope.get(callee.name.text.toLowerCase());
      if (!m) {
        this.local(callee, 'call');
        this.argumentsOnly(e, ctx);
        return UNKNOWN;
      }
      this.reference(callee.name.range, m.id, 'member', 'call');
      const kind = m.section === 'InOut' || m.section === 'Input' ? 'parameter' : 'multi';
      return this.instanceCall(e, ctx, m.type, { kind, id: m.id, name: m.name });
    }
    if (
      callee.kind === 'member' &&
      callee.object.kind === 'local' &&
      this.rootPath(callee) === undefined
    ) {
      // #Delay.TON(...): system FB instruction on an instance (LAD/FBD)
      const m = this.scope.get(callee.object.name.text.toLowerCase());
      if (m && m.type.kind === 'system') {
        this.reference(callee.object.name.range, m.id, 'member', 'call');
        return this.instanceCall(e, ctx, m.type, { kind: 'system', id: m.id, name: m.name });
      }
    }
    const rootPath = this.rootPath(callee);
    let target: BlockSymbol | undefined;
    if (callee.kind === 'global')
      target = this.index.findBlock(callee.name.text, this.symbol.namespace);
    else if (rootPath)
      target = this.index.findBlock(
        rootPath[rootPath.length - 1]!,
        this.symbol.namespace,
        rootPath.slice(0, -1).join('.') || null,
      );
    else if (callee.kind === 'name') {
      const b = this.index.findBlock(callee.name.text, this.symbol.namespace);
      if (b && this.symbol.namespace && (b.namespace ?? '') === this.symbol.namespace) target = b;
    }
    if (target) {
      const nameRange =
        callee.kind === 'member'
          ? callee.member.range
          : callee.kind === 'global' || callee.kind === 'name'
            ? callee.name.range
            : callee.range;
      this.reference(nameRange, target.id, 'block', 'call');
      this.unitAccess(
        target.unit,
        target.published ?? publishedByManifest(target.unit, target.name),
        target.name,
        e.range,
      );
      if (target.kind === 'DB' && target.dbKind === 'instance') {
        const fb = this.index.resolveType(
          target.block.dbType,
          target.namespace,
          target.id,
          target.file.path,
        );
        return this.instanceCall(e, ctx, fb, { kind: 'single', id: target.id, name: target.name });
      }
      if (target.kind === 'FC') {
        this.userCall(e, ctx, target, undefined);
        return this.index.resolveType(
          target.block.returnType,
          target.namespace,
          target.id,
          target.file.path,
        );
      }
      this.argumentsOnly(e, ctx);
      return UNKNOWN;
    }
    if (callee.kind === 'global') {
      this.global(callee.name.text, callee.name.range, 'call');
      this.addCall(e, ctx, undefined, callee.name.text, 'unresolved', undefined, undefined);
      this.argumentsOnly(e, ctx);
      return UNKNOWN;
    }
    if (callee.kind === 'name') return this.instructionCall(e, ctx, callee.name.text);
    this.argumentsOnly(e, ctx);
    return UNKNOWN;
  }

  private instanceCall(
    e: CallExpression,
    ctx: Context,
    type: DataType,
    instance: CallSite['instance'],
  ): DataType {
    if (type.kind === 'fb') {
      const target = this.index.block(type.block.id);
      if (target) this.userCall(e, ctx, target, instance);
      else this.argumentsOnly(e, ctx);
      return UNKNOWN;
    }
    if (type.kind === 'system' && type.type.kind === 'fb') {
      const instruction = type.type.instruction ?? type.type.name;
      this.addCall(
        e,
        ctx,
        `instruction:${instruction.toUpperCase()}`,
        instruction,
        'instruction',
        instance,
        instruction,
      );
      this.checkArguments(e, ctx, type.type.parameters, {
        what: `${instance?.name ?? ''} (${type.type.name})`,
        verified: type.type.verification.verified,
        requireInOut: false,
        requireAll: false,
      });
      return UNKNOWN;
    }
    this.addCall(e, ctx, undefined, instance?.name ?? '', 'unresolved', instance, undefined);
    this.argumentsOnly(e, ctx);
    return UNKNOWN;
  }

  private userCall(
    e: CallExpression,
    ctx: Context,
    target: BlockSymbol,
    instance: CallSite['instance'],
  ): void {
    this.addCall(
      e,
      ctx,
      target.id,
      target.name,
      target.kind === 'FC' ? 'fc' : 'fb',
      instance,
      undefined,
    );
    const members = this.index
      .interfaceMembers(target)
      .filter((m) => m.section === 'Input' || m.section === 'Output' || m.section === 'InOut');
    const params: Parameter[] = members.map((m) => ({
      name: m.name,
      direction: m.section === 'Input' ? 'in' : m.section === 'Output' ? 'out' : 'inout',
      type: '',
      optional: false,
    }));
    const types = new Map(members.map((m) => [m.name.toLowerCase(), m.type]));
    const memberIds = new Map(members.map((m) => [m.name.toLowerCase(), m.id]));
    this.checkArguments(e, ctx, params, {
      what: target.name,
      verified: !target.incomplete,
      requireInOut: target.kind === 'FB',
      requireAll: target.kind === 'FC',
      types,
      memberIds,
    });
  }

  private instructionCall(e: CallExpression, ctx: Context, name: string): DataType {
    const conversion = this.profile.conversion(name);
    const family = this.index.project.cpuFamily;
    if (conversion) {
      this.addCall(
        e,
        ctx,
        `instruction:${name.toUpperCase()}`,
        name,
        'instruction',
        undefined,
        name,
      );
      for (const t of [conversion.from, conversion.to]) {
        if (family && !t.cpuFamilies.includes(family)) {
          this.report(
            e.callee.range,
            'not-available-on-cpu',
            `${name} works with ${t.name}, which does not exist on ${family}.`,
          );
          break;
        }
      }
      for (const a of e.args)
        this.expression(a.value, ctx, a.direction === 'out' ? 'write' : 'read');
      return { kind: 'elementary', name: conversion.to.name, info: conversion.to };
    }
    const instruction = this.profile.instruction(name);
    if (!instruction) {
      this.addCall(
        e,
        ctx,
        `instruction:${name.toUpperCase()}`,
        name,
        'instruction',
        undefined,
        name,
      );
      this.argumentsOnly(e, ctx);
      return UNKNOWN;
    }
    this.reference(
      e.callee.range,
      `instruction:${instruction.name.toUpperCase()}`,
      'instruction',
      'call',
    );
    this.addCall(
      e,
      ctx,
      `instruction:${instruction.name.toUpperCase()}`,
      instruction.name,
      'instruction',
      undefined,
      instruction.name,
    );
    if (family && !instruction.cpuFamilies.includes(family)) {
      this.report(
        e.callee.range,
        'not-available-on-cpu',
        `${instruction.name} does not exist on ${family}.`,
        instruction.verification.verified ? 'error' : 'warning',
      );
    }
    const argTypes = this.checkArguments(e, ctx, instruction.parameters, {
      what: instruction.name,
      verified: instruction.verification.verified,
      requireInOut: false,
      requireAll: false,
      nonFormal: instruction.nonFormal === true,
      variadic: instruction.variadic === true,
    });
    return this.returnType(instruction, argTypes);
  }

  private returnType(instruction: Instruction, argTypes: Map<string, DataType>): DataType {
    const rt = instruction.returnType;
    if (!rt) return UNKNOWN;
    if (rt.startsWith('=')) return argTypes.get(rt.slice(1).toLowerCase()) ?? UNKNOWN;
    if (rt === 'REF') return UNKNOWN;
    return this.typeByName(rt);
  }

  private argumentsOnly(e: CallExpression, ctx: Context): void {
    for (const a of e.args) this.expression(a.value, ctx, a.direction === 'out' ? 'write' : 'read');
  }

  /** Checks names, directions, required parameters and types; returns the argument types. */
  private checkArguments(
    e: CallExpression,
    ctx: Context,
    params: readonly Parameter[],
    opts: {
      what: string;
      verified: boolean;
      requireInOut: boolean;
      requireAll: boolean;
      nonFormal?: boolean;
      variadic?: boolean;
      types?: Map<string, DataType>;
      /** Symbol ids of the parameters (user blocks), so formal names count as references. */
      memberIds?: Map<string, string>;
    },
  ): Map<string, DataType> {
    const argTypes = new Map<string, DataType>();
    const byName = new Map(params.map((p) => [p.name.toLowerCase(), p]));
    const given = new Set<string>();
    let positional = 0;
    for (const a of e.args) {
      let p: Parameter | undefined;
      if (a.name) {
        p = byName.get(a.name.text.toLowerCase());
        const lower = a.name.text.toLowerCase();
        if (!p && lower !== 'en' && lower !== 'eno') {
          const variadicName = opts.variadic && /^in\d+$/i.test(a.name.text);
          if (!variadicName) {
            this.report(
              a.name.range,
              'unknown-parameter',
              `${opts.what} has no parameter ${a.name.text}.${opts.verified ? '' : ' (not yet verified against TIA)'}`,
              opts.verified ? 'error' : 'warning',
            );
          }
        }
        if (p) {
          given.add(p.name.toLowerCase());
          const paramId = opts.memberIds?.get(p.name.toLowerCase());
          if (paramId)
            this.reference(
              a.name.range,
              paramId,
              'member',
              p.direction === 'out' ? 'read' : 'write',
            );
          if (p.direction !== 'out' && a.direction === 'out') {
            // corpus B29: TIA rejects '=>' on an input; ':=' on an output is accepted (C30)
            this.report(
              a.range,
              'parameter-direction',
              `${p.name} is an input: pass it with ':='.`,
            );
          }
        }
      } else {
        p = params.filter((x) => x.direction !== 'out')[positional++];
        if (p) given.add(p.name.toLowerCase());
      }
      const access: Access =
        a.direction === 'out' ? 'write' : p?.direction === 'inout' ? 'readwrite' : 'read';
      const actual = this.expression(a.value, ctx, access);
      if (p) {
        argTypes.set(p.name.toLowerCase(), actual);
        const declared = opts.types?.get(p.name.toLowerCase()) ?? this.paramType(p);
        this.checkArgumentType(declared, actual, a, p, opts.verified);
        // passing the FOR counter to an InOut changes it (TIA refuses this, run log C26h)
        if (p.direction === 'inout') {
          const id = this.symbolOf(a.value);
          if (id && ctx.forCounters.some((c) => c.id === id)) {
            this.report(
              a.value.range,
              'for-counter-modified',
              `The FOR counter is passed to the InOut ${p.name}, which may change it inside the loop (not yet verified against TIA).`,
              'warning',
            );
          }
        }
      }
    }
    for (const p of params) {
      if (given.has(p.name.toLowerCase()) || p.optional) continue;
      if (opts.requireInOut && p.direction === 'inout') {
        this.report(
          e.range,
          'missing-inout-parameter',
          `The InOut parameter ${p.name} of ${opts.what} must be supplied.`,
        );
      } else if (opts.requireAll) {
        this.report(
          e.range,
          'missing-fc-parameter',
          `The parameter ${p.name} of ${opts.what} is not supplied; an FC needs all its parameters.`,
        );
      }
    }
    return argTypes;
  }

  private checkArgumentType(
    declared: DataType,
    actual: DataType,
    a: Argument,
    p: Parameter,
    verified: boolean,
  ): void {
    if (declared.kind === 'generic') {
      const fits = fitsGeneric(declared.name, actual);
      if (fits === false) {
        this.report(
          a.value.range,
          verified ? 'type-mismatch' : 'possible-type-mismatch',
          `${typeName(actual)} does not fit the parameter ${p.name} (${declared.name}).`,
          verified ? 'error' : 'warning',
        );
      }
      return;
    }
    const problem =
      p.direction === 'out'
        ? conversionProblem(actual, declared, this.symbol.iecCheck, undefined)
        : conversionProblem(declared, actual, this.symbol.iecCheck, a.value);
    if (!problem) return;
    const severity = problem.severity === 'error' && !verified ? 'warning' : problem.severity;
    this.report(a.value.range, problem.rule, problem.message, severity);
  }

  private addCall(
    e: CallExpression,
    ctx: Context,
    calleeId: string | undefined,
    calleeName: string,
    kind: CallSite['kind'],
    instance: CallSite['instance'],
    instruction: string | undefined,
  ): void {
    this.calls.push({
      callerId: this.symbol.id,
      file: this.file,
      range: e.range,
      calleeId,
      calleeName,
      kind,
      instance,
      conditional: ctx.conditions.length > 0 || ctx.viaEn,
      conditions: ctx.viaEn ? [...ctx.conditions, 'EN'] : ctx.conditions,
      inLoop: ctx.loopDepth > 0,
      viaEn: ctx.viaEn,
      network: ctx.network,
      args: e.args.map((a) => ({
        parameter: a.name?.text,
        direction: a.direction,
        value: a.value,
      })),
      instruction,
    });
  }

  // --- LAD / FBD ---------------------------------------------------------------------------

  private ladder(network: Network, ctx: Context): void {
    const fbd = network.language === 'FBD';
    for (const rung of network.ladder!.rungs) {
      if (rung.start.kind === 'operand') {
        const t = this.expression(rung.start.operand, ctx, 'read');
        if (!isUnknown(t) && classOf(t) !== 'bool') {
          this.report(
            rung.start.operand.range,
            'type-mismatch',
            `The first input of this rung needs a Bool operand, not ${typeName(t)}.`,
          );
        }
      }
      let behind = rung.start.kind === 'wire' || (fbd && rung.start.kind === 'operand');
      for (const item of rung.items) {
        if (item.kind === 'junction') continue;
        this.ladderElement(
          item,
          { ...ctx, viaEn: behind },
          fbd,
          rung.start.kind === 'operand' && item === rung.items.find((i) => i.kind === 'element'),
        );
        const element = this.profile.ladderElement(item.instruction);
        if (element?.shape === 'contact' || element?.shape === 'box' || !element) behind = true;
      }
    }
  }

  private ladderElement(
    item: LadderElement,
    ctx: Context,
    fbd: boolean,
    firstAfterOperand: boolean,
  ): void {
    const element =
      item.callee.kind === 'name' ? this.profile.ladderElement(item.instruction) : undefined;
    if (!element) {
      // a call of a block or instruction box
      const call: CallExpression = {
        kind: 'call',
        callee: item.callee,
        args: item.args,
        argsRange: item.range,
        range: item.range,
      };
      this.call(call, ctx);
      return;
    }
    if (this.symbol.failsafe && element.failsafeAllowed === false) {
      this.report(
        item.range,
        'failsafe-instruction',
        `${element.name} is not permitted in a fail-safe block (not yet verified against TIA).`,
      );
    }
    if (element.shape === 'jump') {
      const label = item.args[0]?.value;
      if (label?.kind === 'name') {
        if (this.labels.has(label.name.text.toLowerCase()))
          this.reference(
            label.range,
            `label:${this.symbol.id}/${label.name.text.toLowerCase()}`,
            'label',
            'read',
          );
        else
          this.report(
            label.range,
            'unknown-label',
            `The jump label ${label.name.text} does not exist in this block.`,
          );
      }
      return;
    }
    const verified = element.verification.verified;
    const byName = new Map(element.parameters.map((p) => [p.name.toLowerCase(), p]));
    const given = new Set<string>();
    let positional = 0;
    for (const a of item.args) {
      const p = a.name ? byName.get(a.name.text.toLowerCase()) : element.parameters[positional++];
      if (a.name && !p && !/^(in|out)\d+$/i.test(a.name.text) && !/^en|eno$/i.test(a.name.text)) {
        this.report(
          a.name.range,
          'unknown-parameter',
          `${element.name} has no input or output ${a.name.text}.${verified ? '' : ' (not yet verified against TIA)'}`,
          verified ? 'error' : 'warning',
        );
      }
      if (p) given.add(p.name.toLowerCase());
      const access: Access =
        p?.direction === 'out' || a.direction === 'out'
          ? 'write'
          : p?.direction === 'inout'
            ? 'readwrite'
            : 'read';
      const actual = this.expression(a.value, ctx, access);
      if (!p) continue;
      const declared = this.paramType(p);
      if (declared.kind === 'generic') {
        const fits = fitsGeneric(declared.name, actual);
        if (fits === false)
          this.report(
            a.value.range,
            verified ? 'type-mismatch' : 'possible-type-mismatch',
            `${typeName(actual)} does not fit ${p.name} of ${element.name} (${declared.name}).`,
            verified ? 'error' : 'warning',
          );
      } else {
        const problem =
          p.direction === 'out'
            ? conversionProblem(actual, declared, this.symbol.iecCheck, undefined)
            : conversionProblem(declared, actual, this.symbol.iecCheck, a.value);
        if (problem)
          this.report(
            a.value.range,
            problem.rule,
            problem.message,
            problem.severity === 'error' && !verified ? 'warning' : problem.severity,
          );
      }
    }
    for (const p of element.parameters) {
      if (p.direction !== 'in' || p.optional || given.has(p.name.toLowerCase())) continue;
      // in FBD the first input of the first box is fed by the rung's operand
      if (fbd && firstAfterOperand && p === element.parameters.find((x) => x.direction === 'in'))
        continue;
      this.report(
        item.range,
        'missing-box-input',
        `The input ${p.name} of ${element.name} is not connected.`,
        verified ? 'error' : 'warning',
      );
    }
  }
}

function childStatements(s: Statement): readonly (readonly Statement[])[] {
  switch (s.kind) {
    case 'if':
      return [...s.branches.map((b) => b.body), ...(s.elseBody ? [s.elseBody] : [])];
    case 'case':
      return [...s.clauses.map((c) => c.body), ...(s.elseBody ? [s.elseBody] : [])];
    case 'for':
    case 'while':
    case 'repeat':
    case 'region':
      return [s.body];
    default:
      return [];
  }
}

function elementary(profile: ProfileIndex, name: string): DataType {
  const info = profile.elementary(name);
  return info ? { kind: 'elementary', name: info.name, info } : UNKNOWN;
}

function publishedByManifest(unit: UnitInfo | undefined, name: string): boolean | undefined {
  if (!unit) return undefined;
  if (unit.published.length === 0) return undefined;
  return unit.published.some((p) => p.toLowerCase() === name.toLowerCase());
}

export { blockId, systemMember };
export type { TagSymbol };
