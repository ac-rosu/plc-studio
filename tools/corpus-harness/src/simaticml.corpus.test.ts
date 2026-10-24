// SimaticML blocks, read only (M14, ADR 0014): every block export of the corpus reads, and what
// the views show from the XML equals what TIA's SIMATIC SD export of the same block says.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SourceText,
  flgNetToRungs,
  isSimaticmlBlock,
  ladderBlockView,
  parseResources,
  simaticmlToSd,
  parseBlockText,
  readSimaticmlBlock,
  simaticmlToScl,
  structuredText,
} from '@plcstudio/core';
import {
  dataBlockModel,
  interfaceModel,
  type Row,
} from '../../../packages/extension/src/features/tables-model.ts';
import {
  xmlBlockKind,
  xmlDataBlockModel,
  xmlInterfaceModel,
} from '../../../packages/extension/src/features/xml-models.ts';
import { corpusProject, plcFilePath } from './core-adapters.ts';
import { assemblePlcs, corpusVersions, loadCases } from './corpus.ts';
import { profileIndex } from '@plcstudio/profiles';

const corpusRoot = fileURLToPath(new URL('../../../corpus', import.meta.url));
const all = corpusVersions(corpusRoot).flatMap((version) => loadCases(corpusRoot, version));
const read = (file: string) => SourceText.fromBytes(new Uint8Array(readFileSync(file))).text;

const exports = all.flatMap((c) =>
  c.files
    .filter((f) => f.variant === 'simaticml' && !f.objectName.endsWith('.readonly'))
    .map((f) => ({ c, f, text: read(f.absolutePath) }))
    .filter(({ text }) => isSimaticmlBlock(text)),
);

/** The SIMATIC SD document of the same block, if the case has one. */
function sdDocument(caseDirectory: string, name: string): string | undefined {
  const file = path.join(caseDirectory, 'documents', `${name}.s7dcl`);
  return existsSync(file) ? read(file) : undefined;
}

/**
 * The SD network bodies: the lines between NETWORK and END_NETWORK, and how far SD indents the
 * stored code (four spaces more than NETWORK: eight, or twelve inside a NAMESPACE).
 */
function sdNetworkBodies(sd: string): { bodies: string[]; indent: number } {
  const lines = sd.split('\r\n');
  const bodies: string[] = [];
  let indent = 8;
  let current: string[] | undefined;
  for (const line of lines) {
    if (/^\s*NETWORK\s*$/.test(line)) {
      current = [];
      indent = line.length - line.trimStart().length + 4;
    } else if (/^\s*END_NETWORK\s*$/.test(line) && current) {
      bodies.push(current.join('\r\n'));
      current = undefined;
    } else current?.push(line);
  }
  return { bodies, indent };
}

describe('SimaticML block exports', () => {
  it('the corpus has block exports of every kind', () => {
    const kinds = new Set(exports.map(({ text }) => readSimaticmlBlock(text)?.kind));
    expect([...kinds].sort()).toEqual([
      'ArrayDB',
      'FB',
      'FC',
      'GlobalDB',
      'InstanceDB',
      'OB',
      'UDT',
    ]);
  });

  it('the corpus has V20 and V21 exports, in the schema namespaces the profile lists', () => {
    expect([...new Set(exports.map(({ c }) => c.version))].sort()).toEqual(['V20', 'V21']);
    const known = profileIndex('V21')!.profile.simaticmlSchemas!.namespaces;
    for (const version of ['V20', 'V21']) {
      const used = new Set(
        exports
          .filter(({ c }) => c.version === version)
          .flatMap(({ text }) => [...text.matchAll(/xmlns="([^"]+)"/g)].map((m) => m[1]!)),
      );
      expect([...used].sort(), version).toEqual([...known].sort());
    }
  });

  it.each(exports.map((e) => [`${e.c.version}/${e.c.folder}/${e.f.path}`, e] as const))(
    '%s: reads, and its SCL networks come back as TIA stores them',
    (_name, { c, f, text }) => {
      const block = readSimaticmlBlock(text)!;
      expect(block.name).toBe(f.objectName);
      expect(block.version).toBe(c.version);
      const sd = sdDocument(c.directory, f.objectName);
      if (!sd) return;
      const { bodies, indent } = sdNetworkBodies(sd);
      block.networks.forEach((n, i) => {
        if (n.language !== 'SCL' || !n.source) return;
        const rebuilt = structuredText(n.source, { namespace: block.namespace })
          .split('\n')
          .map((l) => ' '.repeat(indent) + l)
          .join('\r\n');
        expect(rebuilt, `network ${n.index}`).toBe(bodies[i]);
      });
      // the SD parser agrees on the number of networks
      expect(block.networks.length).toBe(
        parseBlockText(sd, 's7dcl').blocks[0]?.networks.length ?? 0,
      );
    },
  );
});

// The tables of a SimaticML block show what the tables of its SIMATIC SD document show.
describe('SimaticML tables equal the SIMATIC SD tables', () => {
  // PLC_Main of every TIA version, each with its own project
  const plcs = assemblePlcs(all, 'documents')
    .filter((p) => p.name === 'PLC_Main')
    .map((plc) => ({ plc, project: corpusProject(plc, corpusRoot).project }));
  type Project = (typeof plcs)[number]['project'];
  const input = (project: Project, path: string) => ({
    project,
    path,
    cultures: ['de-DE', 'en-US'],
    culture: 'en-US',
    diagnostics: [],
  });
  // SD writes a PLC data type as _.UDT_X (_.Unit.UDT_X), the XML as "UDT_X"
  const type = (t: string) => t.replace(/_\.([A-Za-z0-9_.]+)/g, '"$1"');
  const elementary = (t: string) => !/["_]|^Array|Struct|_TIME$|TRIG$|COUNTER$/.test(type(t));
  /**
   * What both formats carry. Left out: comments of instance DB members (an instance DB's XML has
   * none, the SD view takes them from the FB), retain below the top level and in instance DBs
   * (not shown as settable there), and setpoint of structured members (the XML marks PLC data
   * types and multi-instances as setpoint, SIMATIC SD writes nothing for them).
   */
  const view = (rows: readonly Row[], instance = false) =>
    rows.map((r) => ({
      path: r.path.join('.'),
      type: type(r.type),
      value: r.value.replace(/\s+/g, ''),
      comment: instance ? '' : r.comment,
      retain: r.level === 0 && !instance ? r.retain : null,
      flags: [r.accessible, r.visible, r.writable],
      setpoint: elementary(r.type) ? r.setpoint : null,
      structured: r.structured,
    }));
  const pairs = exports.flatMap(({ c, f, text }) => {
    const block = readSimaticmlBlock(text)!;
    const owner = plcs.find(({ plc }) => plc.cases.includes(c));
    const sd = owner?.plc.files.find(
      (x) => x.variant === 'documents' && x.extension === '.s7dcl' && x.objectName === block.name,
    );
    return owner && sd
      ? [
          [
            `${c.version}/${c.folder}/${f.path}`,
            block,
            input(owner.project, plcFilePath(owner.plc, sd)),
          ] as const,
        ]
      : [];
  });

  /**
   * The XML also lists the members of system block instances (a TON_TIME's IN, PT, Q, ET), which
   * the SD view shows as one row; and names the unit's own types in full ("Filling.UDT_X").
   */
  const comparable = (xml: readonly Row[], sd: readonly Row[], namespace: string | undefined) => {
    const leaves = sd.filter((r) => !r.structured).map((r) => r.path.join('.'));
    const own = namespace ? new RegExp(`"${namespace}\\.([^"]+)"`, 'g') : undefined;
    return xml
      .filter((r) => !leaves.some((l) => r.path.join('.').startsWith(`${l}.`)))
      .map((r) => ({
        ...r,
        type: own ? r.type.replace(own, '$1') : r.type,
        structured: leaves.includes(r.path.join('.')) ? false : r.structured,
      }));
  };

  it.each(pairs)('%s', (_name, block, sdInput) => {
    if (xmlBlockKind(block) === 'DB') {
      const instance = block.kind === 'InstanceDB';
      const sd = dataBlockModel(sdInput).rows;
      expect(
        view(comparable(xmlDataBlockModel(block, 'en-US').rows, sd, block.namespace), instance),
      ).toEqual(view(sd, instance));
    } else {
      // the XML of an OB also lists its start information (Input), which SD leaves out
      const sd = interfaceModel(sdInput).sections;
      const xml = xmlInterfaceModel(block, 'en-US').sections.filter((s) =>
        sd.some((x) => x.kind === s.kind),
      );
      expect(
        xml.map((s, i) => [
          s.kind,
          view(comparable(s.rows, sd[i]?.rows ?? [], block.namespace)),
          s.returnType,
        ]),
      ).toEqual(sd.map((s) => [s.kind, view(s.rows), s.returnType]));
    }
  });
});

// The SCL view of a SimaticML block: valid source text whose code is TIA's external source.
describe('SCL view of SimaticML blocks', () => {
  const sclBlocks = exports.flatMap(({ c, f, text }) => {
    const block = readSimaticmlBlock(text)!;
    const source = path.join(c.directory, 'source', `${block.name}.scl`);
    return block.networks.some((n) => n.language === 'SCL') && block.kind !== 'UDT'
      ? [
          [
            `${c.version}/${c.folder}/${f.path}`,
            block,
            existsSync(source) ? read(source) : undefined,
          ] as const,
        ]
      : [];
  });

  it.each(sclBlocks)('%s', (_name, block, source) => {
    const view = simaticmlToScl(block, 'en-US', 'read-only');
    const parsed = parseBlockText(view.replace(/\n/g, '\r\n'), 'source');
    expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(parsed.blocks[0]?.name.text).toBe(block.name);
    expect(parsed.blocks[0]?.namespace ?? parsed.namespace?.name).toBe(block.namespace);
    if (!source || block.networks.some((n) => n.language !== 'SCL')) return;
    // the code, from the last BEGIN (a source can hold several blocks, C42), is TIA's own source
    const code = (t: string) =>
      t
        .replace(/\r\n/g, '\n')
        .replace(/^[\s\S]*\nBEGIN\n/, '')
        .trimEnd();
    expect(code(view)).toBe(code(source));
  });
});

// LAD/FBD networks of SimaticML exports become the SD rungs TIA itself writes for them.
describe('LAD/FBD networks from SimaticML', () => {
  const profile = profileIndex('V21')!;
  const networks = exports.flatMap(({ c, f, text }) => {
    const block = readSimaticmlBlock(text)!;
    const sd = sdDocument(c.directory, f.objectName);
    if (!sd) return [];
    const { bodies, indent } = sdNetworkBodies(sd);
    return block.networks
      .filter((n) => n.source && /^(F_)?(LAD|FBD)$/.test(n.language))
      .map(
        (n) =>
          [
            `${c.version}/${c.folder}/${f.objectName} network ${n.index}`,
            block,
            n,
            bodies[n.index - 1]!,
            indent,
          ] as const,
      );
  });

  it.each(networks)('%s', (_name, block, n, body, indent) => {
    const result = flgNetToRungs(n.source!, {
      profile,
      language: n.language.endsWith('FBD') ? 'FBD' : 'LAD',
      namespace: block.namespace,
    });
    expect('unsupported' in result ? result.unsupported : undefined).toBeUndefined();
    if (!('lines' in result)) return;
    // SD quotes some plain local names (#"Limit"); the LAD editor and the XML do not. V20 writes a
    // space after the comma between parameters, V21 does not.
    const sd = body.replace(/#"([A-Za-z_][A-Za-z0-9_]*)"/g, '#$1').replace(/, \r\n/g, ',\r\n');
    expect(result.lines.map((l) => ' '.repeat(indent) + l).join('\r\n')).toBe(sd);
  });
});

// The LAD/FBD view of a SimaticML block draws what the view of its SIMATIC SD document draws.
describe('LAD/FBD view of SimaticML blocks', () => {
  const profile = profileIndex('V21')!;
  const blocks = exports.flatMap(({ c, f, text }) => {
    const block = readSimaticmlBlock(text)!;
    const sd = sdDocument(c.directory, f.objectName);
    const res = path.join(c.directory, 'documents', `${f.objectName}.s7res`);
    return sd && block.networks.some((n) => /(LAD|FBD)$/.test(n.language))
      ? [
          [
            `${c.version}/${c.folder}/${f.objectName}`,
            block,
            sd,
            existsSync(res) ? read(res) : undefined,
          ] as const,
        ]
      : [];
  });
  const drawing = (s7dcl: string, s7res: string | undefined) =>
    ladderBlockView(parseBlockText(s7dcl, 's7dcl'), {
      profile,
      resources: s7res === undefined ? undefined : parseResources(new SourceText(s7res)),
      displayLanguage: 'en-US',
    })!.networks.map((n) => ({
      kind: n.kind,
      title: n.title,
      comment: n.comment,
      labels: n.labels.map((l) => l.name),
      elements: n.layout?.elements.map((e) => ({
        at: [e.x, e.y, e.w, e.h],
        instruction: e.instruction,
        label: e.label.replace(/#"([A-Za-z_][A-Za-z0-9_]*)"/g, '#$1'),
      })),
    }));

  it.each(blocks)('%s', (_name, block, sd, res) => {
    const xml = simaticmlToSd(block, profile);
    expect(xml.untranslated).toEqual([]);
    expect(
      parseBlockText(xml.s7dcl, 's7dcl').diagnostics.filter((d) => d.severity === 'error'),
    ).toEqual([]);
    // C19's SD export has no network titles while its XML has them: titles count where SD has any
    const view = (v: ReturnType<typeof drawing>) =>
      res === undefined ? v.map((n) => ({ ...n, title: undefined, comment: undefined })) : v;
    expect(view(drawing(xml.s7dcl, xml.s7res))).toEqual(view(drawing(sd, res)));
  });
});
