// The extension's core, seen through the harness interfaces.
import { parseBytes, printFile } from '@plcstudio/core';
import type { Checker, HarnessDiagnostic, Printer } from './gates.ts';
import { readFileSync } from 'node:fs';

/** Parse with core, then print the unchanged tree (M1). */
export const corePrinter: Printer = {
  name: 'core parsers',
  roundTrip(bytes, file) {
    const parsed = parseBytes(file.path, bytes);
    if (!parsed) throw new Error(`no parser for ${file.path}`);
    return parsed.source.toBytes(printFile(parsed));
  },
};

/** Syntax diagnostics of every file of the PLC (until the project checker exists). */
export const syntaxChecker: Checker = {
  name: 'core syntax',
  async check(plc) {
    const out: HarnessDiagnostic[] = [];
    for (const file of plc.files) {
      const parsed = parseBytes(file.path, new Uint8Array(readFileSync(file.absolutePath)));
      if (!parsed) continue;
      for (const d of parsed.diagnostics) {
        out.push({
          file,
          line: parsed.source.positionAt(d.range.start).line + 1,
          ruleId: d.code,
          severity: d.severity,
          message: d.message,
        });
      }
    }
    return out;
  },
};
