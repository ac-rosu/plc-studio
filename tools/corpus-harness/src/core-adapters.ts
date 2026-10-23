// The extension's core, seen through the harness interfaces.
import { analyzeProject, parseBytes, printFile, Project, SourceText } from '@plcstudio/core';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CorpusFile, CorpusPlc } from './corpus.ts';
import type { Checker, HarnessDiagnostic, Printer } from './gates.ts';

/** Parse with core, then print the unchanged tree (M1). */
export const corePrinter: Printer = {
  name: 'core parsers',
  roundTrip(bytes, file) {
    const parsed = parseBytes(file.path, bytes);
    if (!parsed) throw new Error(`no parser for ${file.path}`);
    return parsed.source.toBytes(printFile(parsed));
  },
};

/** Syntax diagnostics only (kept for comparison). */
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

interface Setup {
  devices: { device: string; deviceTypeIdentifier: string; isFailsafe: boolean }[];
  softwareUnits: { plc: string; name: string; namespace: string; relations: string[] }[];
}

/** plc.json for a corpus PLC, built from the corpus build's setup.json. */
export function corpusManifest(plc: CorpusPlc, corpusRoot: string): string {
  const setupPath = path.join(corpusRoot, plc.version, '_project', 'setup.json');
  const setup: Setup = existsSync(setupPath)
    ? JSON.parse(readFileSync(setupPath, 'utf8'))
    : { devices: [], softwareUnits: [] };
  const device = setup.devices.find((d) => d.device === plc.name);
  const units = setup.softwareUnits
    .filter((u) => u.plc === plc.name)
    .map((u) => ({
      name: u.name,
      folder: `Units/${u.name}`,
      namespace: u.namespace,
      relations: u.relations.map((r) => r.replace(/\s*\(.*\)$/, '')),
      published: [],
    }));
  return JSON.stringify({
    name: plc.name,
    cpu: {
      family: device?.deviceTypeIdentifier.includes('S71200') ? 'S7-1200' : 'S7-1500',
      failsafe: device?.isFailsafe ?? false,
    },
    tiaVersion: plc.version,
    compiler: { iecCheck: false },
    units,
  });
}

/** Where a corpus file lives in the virtual PLC folder: unit objects go into their unit folder. */
function virtualPath(plc: CorpusPlc, file: CorpusFile): string {
  for (const c of plc.cases) {
    if (!(plc.owners.get(file) ?? []).includes(c.folder)) continue;
    const object = c.expected.objects.find(
      (o) => o.name.toLowerCase() === file.objectName.toLowerCase().replace(/\.readonly$/, ''),
    );
    if (object?.unit)
      return `/plc/${plc.name}/Units/${object.unit}/${file.objectName}${file.extension}`;
  }
  return `/plc/${plc.name}/${file.objectName}${file.extension}`;
}

/** The full checker on a project built from the PLC's files (M2/M3 onwards). */
export function projectChecker(corpusRoot: string): Checker {
  return {
    name: 'core project checker',
    async check(plc) {
      const project = new Project(`/plc/${plc.name}`);
      project.setManifest(`/plc/${plc.name}/plc.json`, corpusManifest(plc, corpusRoot));
      const byPath = new Map<string, CorpusFile>();
      for (const file of plc.files) {
        const p = virtualPath(plc, file);
        byPath.set(p.toLowerCase(), file);
        project.setFile(p, SourceText.fromBytes(new Uint8Array(readFileSync(file.absolutePath))));
      }
      // OB attributes come from SimaticML next to the OB (format-notes, finding 1)
      for (const c of plc.cases) {
        for (const f of c.files) {
          if (
            f.variant !== 'simaticml' ||
            !c.expected.objects.some((o) => o.type === 'OB' && f.objectName.startsWith(o.name))
          )
            continue;
          const object = c.expected.objects.find((o) => f.objectName.startsWith(o.name))!;
          const folder = object.unit ? `/plc/${plc.name}/Units/${object.unit}` : `/plc/${plc.name}`;
          project.setFile(
            `${folder}/${f.objectName}${f.extension}`,
            SourceText.fromBytes(new Uint8Array(readFileSync(f.absolutePath))),
          );
        }
      }
      const analysis = analyzeProject(project);
      const out: HarnessDiagnostic[] = [];
      for (const [p, list] of analysis.diagnostics) {
        const file = byPath.get(p.toLowerCase());
        if (!file) continue;
        const source = project.files.get(p)?.source;
        for (const d of list) {
          out.push({
            file,
            line: (source?.positionAt(d.range.start).line ?? 0) + 1,
            ruleId: d.code,
            severity: d.severity,
            message: d.message,
          });
        }
      }
      return out;
    },
  };
}
