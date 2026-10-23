// Declarative custom rules from plcstudio.rules.json (spec): name patterns per object kind,
// forbidden or required instructions, complexity limits, forbidden global access, required
// comments and banned identifiers. Severities are the rule's own (never error).
import type { BlockSymbol } from '../model/project.ts';
import type { CustomRule, ObjectKind, RulesConfig } from './config.ts';
import type { AnalyzerContext } from './context.ts';
import { blockStatements, measureComplexity, type Finding } from './single-block.ts';

interface Named {
  readonly kind: ObjectKind;
  readonly name: string;
  readonly file: string;
  readonly range: { start: number; end: number };
  /** Comment text, or undefined when the files cannot tell (SIMATIC SD block titles). */
  readonly comment: string | undefined | null;
}

/** Every named object of the project with its kind (for name and comment rules). */
export function namedObjects(ctx: AnalyzerContext): Named[] {
  const index = ctx.project.index;
  const out: Named[] = [];
  for (const b of index.blocks) {
    out.push({
      kind: b.kind === 'DB' ? 'DB' : b.kind,
      name: b.name,
      file: b.file.path,
      range: b.block.name.range,
      comment: blockComment(b),
    });
    const members =
      b.kind === 'UDT'
        ? (b.block.struct?.members ?? [])
        : b.block.sections.flatMap((s) =>
            s.members.map((m) => ({ m, constant: s.kind === 'Constant' })),
          );
    for (const entry of members) {
      const m = 'm' in entry ? entry.m : entry;
      const constant = 'm' in entry ? entry.constant : false;
      out.push({
        kind: constant ? 'Constant' : 'Member',
        name: m.name.text,
        file: b.file.path,
        range: m.name.range,
        comment: memberComment(ctx, b, m.comment?.text, m.attributes),
      });
    }
  }
  for (const t of index.tags) {
    const comment = [...t.entry.comments.values()].map((c) => c.text).join(' ');
    out.push({
      kind: t.kind === 'tag' ? 'Tag' : 'Constant',
      name: t.name,
      file: t.file.path,
      range: t.entry.nameRange,
      comment: comment || undefined,
    });
  }
  return out;
}

function blockComment(b: BlockSymbol): string | undefined | null {
  if (b.file.kind === 's7dcl') return null; // SIMATIC SD documents carry no block title or comment
  return b.block.title?.text || undefined;
}

function memberComment(
  ctx: AnalyzerContext,
  b: BlockSymbol,
  inline: string | undefined,
  attributes: readonly { name: string; value: string }[],
): string | undefined {
  if (inline) return inline;
  const id = attributes.find((a) => a.name === 'S7_MLC')?.value;
  if (!id) return undefined;
  const res = ctx.project.index.resourcesFor(b.file);
  const entry = res?.entries.find((e) => e.id === id);
  return entry?.values.find((v) => v.text.trim() !== '')?.text;
}

export function customFindings(ctx: AnalyzerContext, config: RulesConfig): Finding[] {
  if (config.custom.length === 0) return [];
  const findings: Finding[] = [];
  const objects = namedObjects(ctx);
  for (const rule of config.custom) {
    const add = (file: string, range: { start: number; end: number }, message: string) =>
      findings.push({
        rule: rule.id,
        file,
        range,
        message: rule.message ? `${rule.message} (${message})` : message,
      });
    switch (rule.kind) {
      case 'namePattern': {
        let re: RegExp;
        try {
          re = new RegExp(rule.pattern);
        } catch {
          continue;
        }
        for (const o of objects)
          if (o.kind === rule.target && !re.test(o.name))
            add(o.file, o.range, `${o.name} does not match ${rule.pattern}.`);
        break;
      }
      case 'forbiddenInstruction':
        for (const call of ctx.analysis.calls) {
          if (
            (call.instruction ?? call.calleeName).toUpperCase() === rule.instruction.toUpperCase()
          )
            add(call.file, call.range, `${rule.instruction} is not allowed in this project.`);
        }
        for (const b of ctx.project.index.blocks) {
          for (const n of b.block.networks)
            for (const r of n.ladder?.rungs ?? [])
              for (const i of r.items) {
                if (
                  i.kind === 'element' &&
                  i.instruction.toUpperCase() === rule.instruction.toUpperCase()
                )
                  add(b.file.path, i.range, `${rule.instruction} is not allowed in this project.`);
              }
        }
        break;
      case 'requiredInstruction': {
        const kinds = rule.in ?? ['OB', 'FB', 'FC'];
        for (const b of ctx.project.index.blocks) {
          if (!(kinds as string[]).includes(b.kind)) continue;
          const calls = ctx.analysis.blocks.get(b.id)?.calls ?? [];
          if (
            !calls.some(
              (c) =>
                (c.instruction ?? c.calleeName).toUpperCase() === rule.instruction.toUpperCase(),
            )
          ) {
            add(
              b.file.path,
              b.block.name.range,
              `${b.name} does not call ${rule.instruction}, which this project requires.`,
            );
          }
        }
        break;
      }
      case 'complexityLimit':
        for (const b of ctx.project.index.blocks) {
          if (b.kind === 'DB' || b.kind === 'UDT') continue;
          const { cyclomatic, nesting } = measureComplexity(blockStatements(b));
          if (rule.maxCyclomatic !== undefined && cyclomatic > rule.maxCyclomatic)
            add(
              b.file.path,
              b.block.name.range,
              `cyclomatic complexity ${cyclomatic}, limit ${rule.maxCyclomatic}.`,
            );
          if (rule.maxNesting !== undefined && nesting > rule.maxNesting)
            add(
              b.file.path,
              b.block.name.range,
              `nesting depth ${nesting}, limit ${rule.maxNesting}.`,
            );
        }
        break;
      case 'forbiddenGlobalAccess': {
        const kinds = rule.in ?? ['FB', 'FC'];
        for (const ba of ctx.analysis.blocks.values()) {
          if (!(kinds as string[]).includes(ba.symbol.kind)) continue;
          for (const r of ba.references) {
            if (r.access === 'declaration' || r.access === 'type') continue;
            const isGlobal =
              r.symbolKind === 'tag' ||
              r.symbolKind === 'constant' ||
              (r.symbolKind === 'block' && ctx.blockSymbol(r.symbolId)?.kind === 'DB');
            if (isGlobal)
              add(
                r.file,
                r.range,
                `${ba.symbol.name} accesses global data (${ctx.text(r.file, r.range.start, r.range.end)}).`,
              );
          }
        }
        break;
      }
      case 'requiredComment':
        for (const o of objects)
          if (o.kind === rule.target && o.comment === undefined)
            add(o.file, o.range, `${o.name} has no comment.`);
        break;
      case 'bannedIdentifier': {
        const banned = new Set(rule.identifiers.map((i) => i.toLowerCase()));
        for (const o of objects)
          if (banned.has(o.name.toLowerCase()))
            add(o.file, o.range, `the name ${o.name} is banned in this project.`);
        break;
      }
    }
  }
  return findings;
}

export type { CustomRule };
