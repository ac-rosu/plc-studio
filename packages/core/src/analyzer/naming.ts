// Naming presets (spec, "Naming presets"), off by default:
//   default         OB_/FB_/FC_/DB_/UDT_ prefixes + PascalCase, constants SCREAMING_SNAKE_CASE,
//                   everything else PascalCase without a prefix, words spelled out
//   siemens-prefix  role prefixes on locals: inStart, outDone, inOutData, statSpeed, tempIndex
//   match-workspace the scheme the PLC already uses; only deviations are reported
import type { BlockSymbol } from '../model/project.ts';
import type { SectionKind } from '../syntax/ast.ts';
import type { RulesConfig } from './config.ts';
import type { AnalyzerContext } from './context.ts';
import type { Finding } from './single-block.ts';

const BLOCK_PREFIX: Record<string, string> = {
  OB: 'OB_',
  FB: 'FB_',
  FC: 'FC_',
  DB: 'DB_',
  UDT: 'UDT_',
};
const ROLE_PREFIX: Partial<Record<SectionKind, string>> = {
  Input: 'in',
  Output: 'out',
  InOut: 'inOut',
  Static: 'stat',
  Temp: 'temp',
};

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const SCREAMING = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const CAMEL = /^[a-z][A-Za-z0-9]*$/;
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** Common shortened words and the spelled-out form (spec: words spelled out). */
const ABBREVIATIONS: Record<string, string> = {
  Cnt: 'Count',
  Cmd: 'Command',
  Msg: 'Message',
  Err: 'Error',
  Val: 'Value',
  Pos: 'Position',
  Spd: 'Speed',
  Num: 'Number',
  Btn: 'Button',
  Lvl: 'Level',
  Tmr: 'Timer',
  Ctr: 'Counter',
  Cfg: 'Configuration',
  Idx: 'Index',
  Prev: 'Previous',
  Cur: 'Current',
  Calc: 'Calculated',
  Pres: 'Pressure',
  Sts: 'Status',
  Ack: 'Acknowledge',
};

interface Item {
  readonly name: string;
  readonly file: string;
  readonly range: { start: number; end: number };
  readonly role: 'block' | 'member' | 'constant' | 'tag';
  readonly section?: SectionKind;
  readonly block?: BlockSymbol;
}

function items(ctx: AnalyzerContext): Item[] {
  const out: Item[] = [];
  for (const b of ctx.project.index.blocks) {
    out.push({
      name: b.name,
      file: b.file.path,
      range: b.block.name.range,
      role: 'block',
      block: b,
    });
    if (b.kind === 'DB' || b.kind === 'UDT') continue;
    for (const s of b.block.sections) {
      for (const m of s.members) {
        out.push({
          name: m.name.text,
          file: b.file.path,
          range: m.name.range,
          role: s.kind === 'Constant' ? 'constant' : 'member',
          section: s.kind,
          block: b,
        });
      }
    }
  }
  for (const t of ctx.project.index.tags)
    out.push({
      name: t.name,
      file: t.file.path,
      range: t.entry.nameRange,
      role: t.kind === 'tag' ? 'tag' : 'constant',
    });
  return out;
}

function words(name: string): string[] {
  return name.replace(/^(OB|FB|FC|DB|UDT)_/, '').match(/[A-Z][a-z0-9]*|[a-z][a-z0-9]*/g) ?? [];
}

function styleOf(item: Item): string {
  if (item.role === 'block')
    return BLOCK_PREFIX[item.block!.kind] && item.name.startsWith(BLOCK_PREFIX[item.block!.kind]!)
      ? 'prefixed'
      : 'plain';
  if (item.role === 'constant') return SCREAMING.test(item.name) ? 'screaming' : 'other';
  const prefix = item.section ? ROLE_PREFIX[item.section] : undefined;
  if (prefix && item.name.startsWith(prefix) && /^[A-Z]/.test(item.name.slice(prefix.length)))
    return 'role-prefix';
  if (PASCAL.test(item.name)) return 'pascal';
  if (CAMEL.test(item.name)) return 'camel';
  if (SNAKE.test(item.name)) return 'snake';
  return 'other';
}

const STYLE_TEXT: Record<string, string> = {
  prefixed: 'a type prefix (OB_, FB_ ...)',
  plain: 'no type prefix',
  screaming: 'SCREAMING_SNAKE_CASE',
  'role-prefix': 'a role prefix (in, out, stat, temp ...)',
  pascal: 'PascalCase',
  camel: 'camelCase',
  snake: 'snake_case',
};

export function namingFindings(ctx: AnalyzerContext, config: RulesConfig): Finding[] {
  const preset = config.naming;
  if (!preset) return [];
  const all = items(ctx);
  const findings: Finding[] = [];
  const add = (i: Item, message: string) =>
    findings.push({ rule: 'naming-convention', file: i.file, range: i.range, message });
  if (preset === 'match-workspace') {
    const categories = new Map<string, Item[]>();
    for (const i of all) {
      const key = i.role === 'block' ? `block:${i.block!.kind}` : i.role;
      categories.set(key, [...(categories.get(key) ?? []), i]);
    }
    for (const list of categories.values()) {
      if (list.length < 5) continue;
      const counts = new Map<string, number>();
      for (const i of list) counts.set(styleOf(i), (counts.get(styleOf(i)) ?? 0) + 1);
      const [major, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
      if (n / list.length < 0.6 || major === 'other') continue;
      for (const i of list) {
        const s = styleOf(i);
        if (s !== major)
          add(
            i,
            `${i.name} uses ${STYLE_TEXT[s] ?? 'another style'}; most names of this kind in the PLC use ${STYLE_TEXT[major] ?? major}.`,
          );
      }
    }
    return findings;
  }
  for (const i of all) {
    if (i.role === 'constant') {
      if (!SCREAMING.test(i.name))
        add(i, `The constant ${i.name} should be written in SCREAMING_SNAKE_CASE.`);
      continue;
    }
    if (i.role === 'block') {
      if (preset !== 'default') continue;
      const prefix = BLOCK_PREFIX[i.block!.kind] ?? '';
      if (!i.name.startsWith(prefix) || !PASCAL.test(i.name.slice(prefix.length)))
        add(i, `${i.name} should start with ${prefix} followed by a PascalCase name.`);
    } else if (preset === 'siemens-prefix' && i.role === 'member') {
      const prefix = i.section ? ROLE_PREFIX[i.section] : undefined;
      if (prefix && (!i.name.startsWith(prefix) || !/^[A-Z]/.test(i.name.slice(prefix.length)))) {
        add(
          i,
          `${i.name} should start with the role prefix "${prefix}" (for example ${prefix}${i.name.charAt(0).toUpperCase()}${i.name.slice(1)}).`,
        );
      }
      continue;
    } else if (preset === 'default') {
      if (!PASCAL.test(i.name)) add(i, `${i.name} should be PascalCase without a prefix.`);
    }
    if (preset === 'default') {
      for (const w of words(i.name)) {
        const spelled = ABBREVIATIONS[w];
        if (spelled) {
          add(i, `${i.name} shortens "${spelled}" to "${w}"; spell words out.`);
          break;
        }
      }
    }
  }
  return findings;
}
