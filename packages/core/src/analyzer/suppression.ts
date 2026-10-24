// Inline suppression with a required reason (spec, "Configuration and custom rules"):
//   // plcstudio-disable-next-line <rule-id>[, <rule-id> ...] -- <reason>
//   // plcstudio-disable-line <rule-id> ... -- <reason>     (on the line itself)
//   // plcstudio-disable <rule-id> ... -- <reason>          (from here to the end of the block)
// (* ... *) comments work the same way. Only warnings and info can be suppressed: errors mean TIA
// rejects the code, or a policy error (ADR 0013).
import type { LocatedDiagnostic, Project, ProjectFile } from '../model/project.ts';
import { T } from '../syntax/lexer.ts';

export interface Suppression {
  readonly rules: ReadonlySet<string>;
  /** 0-based lines, inclusive. */
  readonly fromLine: number;
  readonly toLine: number;
}

const DIRECTIVE =
  /plcstudio-disable(-next-line|-line)?\s+([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)\s*(?:--\s*(.*))?/i;

export interface SuppressionScan {
  readonly suppressions: Suppression[];
  /** Directives without a reason: reported, not applied. */
  readonly withoutReason: LocatedDiagnostic[];
}

const scans = new WeakMap<ProjectFile, SuppressionScan>();

export function scanSuppressions(project: Project): Map<string, SuppressionScan> {
  const out = new Map<string, SuppressionScan>();
  for (const file of project.files.values()) {
    if (file.parsed?.kind !== 'blocks') continue;
    // a file version is scanned once (M2.9)
    let scan = scans.get(file);
    if (!scan) scans.set(file, (scan = scanFile(file)));
    out.set(file.path, scan);
  }
  return out;
}

function scanFile(file: ProjectFile): SuppressionScan {
  const parsed = file.parsed;
  if (parsed?.kind !== 'blocks') return { suppressions: [], withoutReason: [] };
  const suppressions: Suppression[] = [];
  const withoutReason: LocatedDiagnostic[] = [];
  for (const t of parsed.tokens) {
    if (t.kind !== T.LineComment && t.kind !== T.BlockComment) continue;
    const text = file.source.text.slice(t.start, t.end);
    const m = DIRECTIVE.exec(text);
    if (!m) continue;
    const reason = (m[3] ?? '').replace(/\*\)\s*$/, '').trim();
    if (reason === '') {
      withoutReason.push({
        file: file.path,
        range: { start: t.start, end: t.end },
        severity: 'info',
        code: 'suppression-without-reason',
        message: 'This suppression has no reason, so it is not applied. Add one after "--".',
      });
      continue;
    }
    const rules = new Set(m[2]!.split(',').map((r) => r.trim().toLowerCase()));
    const line = file.source.positionAt(t.start).line;
    if (m[1]?.toLowerCase() === '-next-line')
      suppressions.push({ rules, fromLine: line + 1, toLine: line + 1 });
    else if (m[1]?.toLowerCase() === '-line')
      suppressions.push({ rules, fromLine: line, toLine: line });
    else {
      const block = parsed.blocks.find((b) => t.start >= b.range.start && t.end <= b.range.end);
      const end = block ? file.source.positionAt(block.range.end).line : file.source.lineCount;
      suppressions.push({ rules, fromLine: line, toLine: end });
    }
  }
  return { suppressions, withoutReason };
}

/** Removes suppressed warnings and info; adds a note for directives without a reason. */
export function applySuppressions(
  project: Project,
  diagnostics: LocatedDiagnostic[],
): LocatedDiagnostic[] {
  const fileScans = scanSuppressions(project);
  const kept: LocatedDiagnostic[] = [];
  for (const d of diagnostics) {
    const scan = fileScans.get(d.file);
    if (scan && scan.suppressions.length > 0 && d.severity !== 'error') {
      const line = project.files.get(d.file)?.source.positionAt(d.range.start).line ?? -1;
      if (
        scan.suppressions.some(
          (s) => s.rules.has(d.code.toLowerCase()) && line >= s.fromLine && line <= s.toLine,
        )
      )
        continue;
    }
    kept.push(d);
  }
  for (const scan of fileScans.values()) kept.push(...scan.withoutReason);
  return kept;
}
