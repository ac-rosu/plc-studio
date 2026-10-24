// Loads corpus cases from disk and assembles them into PLCs the way a user's PLC folder holds
// them: one file per object, in one exporter's format.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ExpectedCase } from './expected.ts';

export type FileVariant = 'documents' | 'source' | 'simaticml' | 'vci-sd' | 'vci-ml' | 'tagtables';

export interface CorpusFile {
  /** Path relative to the case folder, with '/', as listed in expected.json. */
  readonly path: string;
  readonly absolutePath: string;
  readonly variant: FileVariant;
  /** File name without extension: the object name. */
  readonly objectName: string;
  readonly extension: string;
}

export interface CorpusCase {
  /** Folder name, for example 'C05-scl-sections'. */
  readonly folder: string;
  readonly version: string;
  readonly directory: string;
  readonly expected: ExpectedCase;
  readonly files: readonly CorpusFile[];
}

/** Formats the extension reads and writes; only these must round-trip byte for byte. */
const PARSED: Partial<Record<FileVariant, readonly string[]>> = {
  documents: ['.s7dcl', '.s7res'],
  'vci-sd': ['.s7dcl', '.s7res'],
  source: ['.scl', '.udt', '.db'],
  tagtables: ['.xml'],
};

export function isParsedFile(file: CorpusFile): boolean {
  // SimaticML is read for tag tables only (an Openness export, C04), not for blocks
  if (file.variant === 'simaticml' && file.extension === '.xml')
    return readFileSync(file.absolutePath, 'utf8').includes('<SW.Tags.PlcTagTable');
  return PARSED[file.variant]?.includes(file.extension) ?? false;
}

export function variantOf(relativePath: string): FileVariant {
  if (relativePath.startsWith('vci/SimaticSD/')) return 'vci-sd';
  if (relativePath.startsWith('vci/SimaticML/')) return 'vci-ml';
  const top = relativePath.split('/')[0];
  if (top === 'documents' || top === 'source' || top === 'simaticml' || top === 'tagtables') {
    return top;
  }
  throw new Error(`Unknown export folder in '${relativePath}'`);
}

export function corpusFile(caseDirectory: string, relativePath: string): CorpusFile {
  const extension = path.extname(relativePath).toLowerCase();
  return {
    path: relativePath,
    absolutePath: path.join(caseDirectory, ...relativePath.split('/')),
    variant: variantOf(relativePath),
    objectName: path.basename(relativePath, path.extname(relativePath)),
    extension,
  };
}

/** TIA version folders under the corpus root, for example ['V21']. */
export function corpusVersions(corpusRoot: string): string[] {
  return readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^V\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Every exported file of a case. A tag table's XML is listed both as VCI export and as tag table. */
export function listedFiles(expected: ExpectedCase): string[] {
  const { documents, source, simaticml, vci, tagtables } = expected.exports;
  return [...new Set([documents, source, simaticml, vci, tagtables].flatMap((list) => list ?? []))];
}

/** Every file in a case folder except expected.json, relative and with '/'. */
export function filesOnDisk(caseDirectory: string): string[] {
  return readdirSync(caseDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(caseDirectory, path.join(entry.parentPath, entry.name)))
    .map((relative) => relative.split(path.sep).join('/'))
    .filter((relative) => relative !== 'expected.json')
    .sort();
}

export function loadCases(corpusRoot: string, version: string): CorpusCase[] {
  const versionDirectory = path.join(corpusRoot, version);
  return readdirSync(versionDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => path.join(versionDirectory, entry.name))
    .filter((directory) => existsSync(path.join(directory, 'expected.json')))
    .map((directory) => {
      const expected = JSON.parse(
        readFileSync(path.join(directory, 'expected.json'), 'utf8'),
      ) as ExpectedCase;
      return {
        folder: path.basename(directory),
        version,
        directory,
        expected,
        files: listedFiles(expected).map((relative) => corpusFile(directory, relative)),
      };
    })
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * True when TIA compiled the exported files without errors: the zero-false-errors gate applies.
 * When TIA refused the intended variant on import (B12, B16), the files hold the variant TIA
 * generated instead, and its compile result decides.
 */
export function isTiaClean(corpusCase: CorpusCase): boolean {
  const { state, messagesOfGeneratedVariant } = corpusCase.expected.compile;
  const clean = (value: string | undefined) => value === 'Success' || value === 'Warning';
  return clean(state) || (state === 'importRefused' && clean(messagesOfGeneratedVariant));
}

/** How the files of a PLC are taken from the exports. */
export type PlcVariant = 'documents' | 'vci' | 'source';

export interface CorpusPlc {
  readonly version: string;
  readonly name: string;
  readonly variant: PlcVariant;
  readonly cases: readonly CorpusCase[];
  readonly files: readonly CorpusFile[];
  /** Case folders that own each file (an object can belong to more than one case). */
  readonly owners: ReadonlyMap<CorpusFile, readonly string[]>;
}

const fileName = (file: CorpusFile) => `${file.objectName}${file.extension}`;

function filesForVariant(corpusCase: CorpusCase, variant: PlcVariant): CorpusFile[] {
  const tagTables = corpusCase.files.filter(
    (f) => f.variant === 'tagtables' && f.extension === '.xml',
  );
  const documents = corpusCase.files.filter((f) => f.variant === 'documents');
  switch (variant) {
    case 'documents':
      return [...documents, ...tagTables];
    case 'vci':
      return [...corpusCase.files.filter((f) => f.variant === 'vci-sd'), ...tagTables];
    case 'source': {
      // External sources where TIA could write them; SIMATIC SD for the rest (LAD/FBD).
      const sources = corpusCase.files.filter((f) => f.variant === 'source');
      const withSource = new Set(sources.map((f) => f.objectName));
      return [...sources, ...documents.filter((f) => !withSource.has(f.objectName)), ...tagTables];
    }
  }
}

/**
 * Groups cases by PLC. An object that appears in several cases (an instance DB shared by two
 * cases) must have identical files there; it is loaded once and owned by all of those cases.
 */
export function assemblePlcs(cases: readonly CorpusCase[], variant: PlcVariant): CorpusPlc[] {
  const byPlc = new Map<string, CorpusCase[]>();
  for (const corpusCase of cases) {
    const key = `${corpusCase.version}/${corpusCase.expected.plc}`;
    byPlc.set(key, [...(byPlc.get(key) ?? []), corpusCase]);
  }
  return [...byPlc.values()].map((plcCases) => {
    const first = plcCases[0]!;
    const byName = new Map<string, CorpusFile>();
    const owners = new Map<CorpusFile, string[]>();
    for (const corpusCase of plcCases) {
      for (const file of filesForVariant(corpusCase, variant)) {
        const known = byName.get(fileName(file));
        if (known === undefined) {
          byName.set(fileName(file), file);
          owners.set(file, [corpusCase.folder]);
        } else if (readFileSync(known.absolutePath).equals(readFileSync(file.absolutePath))) {
          owners.get(known)!.push(corpusCase.folder);
        } else {
          throw new Error(
            `${fileName(file)} differs between ${owners.get(known)!.join(', ')} and ${corpusCase.folder}`,
          );
        }
      }
    }
    return {
      version: first.version,
      name: first.expected.plc,
      variant,
      cases: plcCases,
      files: [...byName.values()],
      owners,
    };
  });
}
