// One PLC folder: its manifest, its parsed files and the symbols they declare (spec, M2).
import { profileIndex, type CpuFamily, type ProfileIndex } from '@plcstudio/profiles';
import { fileKindOf, parseSource, type FileKind, type ParsedFile } from '../formats/document.ts';
import type { ResourceFile } from '../formats/s7res.ts';
import type { TagTableEntry, TagTableFile } from '../formats/tag-table.ts';
import type {
  Block,
  BlockFile,
  BlockKind,
  Member,
  NamedType,
  SectionKind,
  SyntaxDiagnostic,
  TypeNode,
} from '../syntax/ast.ts';
import { SourceText, type Range } from '../text/source-text.ts';
import { parseManifest, type Manifest, type ObInfo } from './manifest.ts';
import { dirname, isInside, joinPath, normalizePath, relativePath, stem } from './paths.ts';
import { UNKNOWN, type BlockRef, type DataType, type MemberInfo } from './types.ts';
import { readObAttributes } from './simaticml-ob.ts';
import {
  mergeRulesConfig,
  parseRulesConfig,
  type RulesConfig,
  type RulesConfigInput,
} from '../analyzer/config.ts';

export interface UnitInfo {
  readonly name: string;
  readonly namespace: string;
  readonly folder: string;
  readonly relations: readonly string[];
  readonly published: readonly string[];
}

export interface ProjectFile {
  readonly path: string;
  readonly relativePath: string;
  readonly kind: FileKind;
  readonly source: SourceText;
  readonly parsed: ParsedFile | undefined;
  readonly unit: UnitInfo | undefined;
  readonly version: number;
}

export interface BlockSymbol extends BlockRef {
  readonly kind: BlockKind;
  readonly unit: UnitInfo | undefined;
  readonly file: ProjectFile;
  readonly block: Block;
  readonly dbKind: 'global' | 'instance' | 'array' | undefined;
  /** From the file (S7_UnitAccess / Published); undefined when the file does not say. */
  readonly published: boolean | undefined;
  readonly failsafe: boolean;
  readonly iecCheck: boolean;
  readonly optimized: boolean | undefined;
  /** The block contains text the parser kept as "not analyzed". */
  readonly incomplete: boolean;
}

export interface TagSymbol {
  readonly id: string;
  readonly kind: 'tag' | 'constant' | 'systemConstant';
  readonly name: string;
  readonly entry: TagTableEntry;
  readonly file: ProjectFile;
  readonly table: TagTableFile;
  readonly unit: UnitInfo | undefined;
}

export interface LocatedDiagnostic extends SyntaxDiagnostic {
  readonly file: string;
}

export const blockId = (namespace: string | undefined, name: string) =>
  `block:${namespace ? namespace.toLowerCase() + '.' : ''}${name.toLowerCase()}`;

const key = (namespace: string | undefined, name: string) =>
  `${(namespace ?? '').toLowerCase()}|${name.toLowerCase()}`;

const attr = (block: Block, name: string) =>
  block.attributes.find((a) => a.name.toLowerCase() === name.toLowerCase())?.value;

export class Project {
  readonly root: string;
  manifest: Manifest | undefined;
  manifestPath: string | undefined;
  /** plc.json as written, for quick fixes that edit it. */
  manifestText: string | undefined;
  manifestDiagnostics: SyntaxDiagnostic[] = [];
  /** plcstudio.rules.json in the PLC folder (wins over the workspace's). */
  rulesPath: string | undefined;
  /** plcstudio.rules.json as written, for placing its diagnostics. */
  rulesText: string | undefined;
  rulesDiagnostics: SyntaxDiagnostic[] = [];
  private folderRules: Partial<RulesConfigInput> | undefined;
  private workspaceRules: Partial<RulesConfigInput> | undefined;
  private rulesCache: RulesConfig | undefined;
  readonly files = new Map<string, ProjectFile>();
  private version = 0;
  private indexCache: ProjectIndex | undefined;
  /** Bumped when the manifest or the analyzer settings change: everything is checked again. */
  private settingsVersion = 0;
  /** Symbols of each file, kept while the file and the manifest stay the same (M2.9). */
  private readonly extracted = new Map<string, FileSymbols>();

  constructor(root: string) {
    this.root = normalizePath(root);
  }

  get profile(): ProfileIndex {
    return profileIndex(this.manifest?.tiaVersion ?? 'V21')!;
  }

  get cpuFamily(): CpuFamily | undefined {
    return this.manifest?.cpu.family;
  }

  /** Without a manifest only syntax is checked (spec). */
  get hasManifest(): boolean {
    return this.manifest !== undefined;
  }

  get revision(): number {
    return this.version;
  }

  /** Changes with the manifest and the analyzer settings, not with the files. */
  get settingsRevision(): number {
    return this.settingsVersion;
  }

  setManifest(path: string, text: string): void {
    const result = parseManifest(text);
    this.manifest = result.manifest;
    this.manifestPath = normalizePath(path);
    this.manifestText = text;
    this.manifestDiagnostics = result.diagnostics;
    // units may have changed: re-assign every file
    for (const [p, f] of this.files) this.files.set(p, { ...f, unit: this.unitFor(p) });
    this.settingsVersion++;
    this.invalidate();
  }

  clearManifest(): void {
    this.manifest = undefined;
    this.manifestPath = undefined;
    this.manifestText = undefined;
    this.manifestDiagnostics = [];
    this.settingsVersion++;
    this.invalidate();
  }

  setFile(path: string, source: SourceText): ProjectFile {
    const p = normalizePath(path);
    const file: ProjectFile = {
      path: p,
      relativePath: relativePath(this.root, p),
      kind: fileKindOf(p),
      source,
      parsed: parseSource(p, source),
      unit: this.unitFor(p),
      version: ++this.version,
    };
    this.files.set(p, file);
    this.invalidate();
    return file;
  }

  setFileText(path: string, text: string): ProjectFile {
    const old = this.files.get(normalizePath(path));
    return this.setFile(path, new SourceText(text, old?.source.bom ?? false));
  }

  removeFile(path: string): void {
    if (this.files.delete(normalizePath(path))) this.invalidate();
  }

  private invalidate(): void {
    this.version++;
    this.indexCache = undefined;
    this.rulesCache = undefined;
  }

  /** The PLC folder's plcstudio.rules.json; undefined text removes it. */
  setRules(path: string, text: string | undefined): void {
    if (text === undefined) {
      this.rulesPath = undefined;
      this.rulesText = undefined;
      this.folderRules = undefined;
      this.rulesDiagnostics = [];
    } else {
      const result = parseRulesConfig(text);
      this.rulesPath = normalizePath(path);
      this.rulesText = text;
      this.folderRules = result.config;
      this.rulesDiagnostics = result.diagnostics;
    }
    this.settingsVersion++;
    this.invalidate();
  }

  /** A workspace-level plcstudio.rules.json that applies to this PLC folder. */
  setWorkspaceRules(input: Partial<RulesConfigInput> | undefined): void {
    this.workspaceRules = input;
    this.settingsVersion++;
    this.invalidate();
  }

  /** Effective analyzer settings: the folder's file wins over the workspace's. */
  get rules(): RulesConfig {
    this.rulesCache ??= mergeRulesConfig(this.workspaceRules, this.folderRules);
    return this.rulesCache;
  }

  unitFor(path: string): UnitInfo | undefined {
    for (const u of this.manifest?.units ?? []) {
      if (isInside(path, joinPath(this.root, u.folder))) {
        return {
          name: u.name,
          namespace: u.namespace,
          folder: u.folder,
          relations: u.relations,
          published: u.published,
        };
      }
    }
    return undefined;
  }

  get index(): ProjectIndex {
    this.indexCache ??= new ProjectIndex(this, this.symbolsOfFiles());
    return this.indexCache;
  }

  /**
   * The symbols of every file: taken from the last index when neither the file nor the manifest
   * changed, extracted again otherwise (M2.9). `extracted` counts the files read this time.
   */
  private symbolsOfFiles(): { files: FileSymbols[]; extracted: number } {
    const out: FileSymbols[] = [];
    let extracted = 0;
    for (const [path, file] of this.files) {
      let entry = this.extracted.get(path);
      if (entry?.file !== file || entry.settings !== this.settingsVersion) {
        entry = extractSymbols(this, file);
        this.extracted.set(path, entry);
        extracted++;
      }
      out.push(entry);
    }
    for (const path of [...this.extracted.keys()])
      if (!this.files.has(path)) this.extracted.delete(path);
    return { files: out, extracted };
  }
}

/** What one file declares. */
export interface FileSymbols {
  readonly file: ProjectFile;
  /** Settings revision the symbols were made with (the manifest sets defaults and units). */
  readonly settings: number;
  readonly blocks: readonly BlockSymbol[];
  readonly tags: readonly TagSymbol[];
}

function extractSymbols(project: Project, file: ProjectFile): FileSymbols {
  const blocks: BlockSymbol[] = [];
  const tags: TagSymbol[] = [];
  const parsed = file.parsed;
  if (parsed?.kind === 'blocks') {
    for (const block of parsed.blocks) blocks.push(blockSymbol(project, file, parsed, block));
  } else if (parsed?.kind === 'tagTable') {
    for (const entry of parsed.entries) {
      tags.push({
        id: `${entry.kind === 'tag' ? 'tag' : 'constant'}:${entry.name.toLowerCase()}`,
        kind: entry.kind,
        name: entry.name,
        entry,
        file,
        table: parsed,
        unit: file.unit,
      });
    }
  }
  return { file, settings: project.settingsRevision, blocks, tags };
}

function blockSymbol(
  project: Project,
  file: ProjectFile,
  parsed: BlockFile,
  block: Block,
): BlockSymbol {
  const namespace = block.namespace ?? file.unit?.namespace;
  const unitAccess = attr(block, 'S7_UnitAccess') ?? attr(block, 'Published');
  const safety = attr(block, 'S7_Safety');
  const iec = attr(block, 'S7_IECCheck');
  const optimized = attr(block, 'S7_Optimized') ?? attr(block, 'S7_Optimized_Access');
  return {
    id: blockId(namespace, block.name.text),
    kind: block.kind,
    name: block.name.text,
    namespace,
    unit: file.unit,
    file,
    block,
    dbKind:
      block.kind !== 'DB'
        ? undefined
        : block.dbType === undefined
          ? 'global'
          : block.dbType.kind === 'array'
            ? 'array'
            : 'instance',
    published: unitAccess === undefined ? undefined : /^(published|true)$/i.test(unitAccess),
    failsafe:
      (safety !== undefined && /^true$/i.test(safety)) ||
      (project.manifest?.failsafeBlocks ?? []).some(
        (n) => n.toLowerCase() === block.name.text.toLowerCase(),
      ),
    iecCheck:
      iec !== undefined ? /^true$/i.test(iec) : (project.manifest?.compiler.iecCheck ?? false),
    optimized: optimized === undefined ? undefined : /^true$/i.test(optimized),
    incomplete: parsed.notAnalyzed.some(
      (r) => r.start >= block.range.start && r.end <= block.range.end,
    ),
  };
}

/**
 * Symbols of a project, assembled again whenever a file changes from the per-file symbols, which
 * are extracted again only for changed files (M2.9).
 */
export class ProjectIndex {
  readonly project: Project;
  readonly blocks: BlockSymbol[] = [];
  readonly tags: TagSymbol[] = [];
  readonly diagnostics: LocatedDiagnostic[] = [];
  /** Per-file symbols the index was assembled from. */
  readonly fileSymbols: readonly FileSymbols[];
  /** Files whose symbols were extracted for this index (the others were reused). */
  readonly extractedFiles: number;
  private readonly blocksByKey = new Map<string, BlockSymbol[]>();
  private readonly blocksById = new Map<string, BlockSymbol>();
  private readonly tagsByName = new Map<string, TagSymbol[]>();
  private readonly memberCache = new Map<string, MemberInfo[]>();
  private readonly obInfoCache = new Map<string, ObInfo | undefined>();

  constructor(project: Project, symbols: { files: FileSymbols[]; extracted: number }) {
    this.project = project;
    this.fileSymbols = symbols.files;
    this.extractedFiles = symbols.extracted;
    for (const f of symbols.files) {
      for (const symbol of f.blocks) this.addBlock(symbol);
      for (const tag of f.tags) {
        this.tags.push(tag);
        const k = tag.name.toLowerCase();
        const list = this.tagsByName.get(k);
        if (list) list.push(tag);
        else this.tagsByName.set(k, [tag]);
      }
    }
    this.checkUniqueness();
  }

  private addBlock(symbol: BlockSymbol): void {
    this.blocks.push(symbol);
    const k = key(symbol.namespace, symbol.name);
    const list = this.blocksByKey.get(k);
    if (list) list.push(symbol);
    else this.blocksByKey.set(k, [symbol]);
    if (!this.blocksById.has(symbol.id)) this.blocksById.set(symbol.id, symbol);
  }

  /** Two blocks or two tags with the same name cannot both exist in TIA. */
  private checkUniqueness(): void {
    const seenBlocks = new Map<string, BlockSymbol>();
    for (const b of this.blocks) {
      const k = key(b.namespace, b.name);
      const first = seenBlocks.get(k);
      if (!first) {
        seenBlocks.set(k, b);
        continue;
      }
      if (first.file.kind !== b.file.kind && first.kind === b.kind) {
        // the same block exported twice, as SIMATIC SD and as external source
        this.diagnostics.push({
          file: b.file.path,
          range: b.block.name.range,
          severity: 'warning',
          code: 'exported-twice',
          message: `${b.name} is also exported as ${first.file.relativePath}; only one of the two files is used for checking.`,
        });
        continue;
      }
      this.diagnostics.push({
        file: b.file.path,
        range: b.block.name.range,
        severity: 'error',
        code: 'duplicate-name',
        message: `${b.name} is declared more than once in ${b.namespace ? `namespace ${b.namespace}` : 'the main program'} (also in ${first.file.relativePath}).`,
      });
    }
    for (const [, list] of this.tagsByName) {
      const distinct = list.filter(
        (t, i) =>
          list.findIndex(
            (o) => o.file.path === t.file.path && o.entry.range.start === t.entry.range.start,
          ) === i,
      );
      if (distinct.length > 1) {
        for (const t of distinct.slice(1)) {
          this.diagnostics.push({
            file: t.file.path,
            range: t.entry.nameRange,
            severity: 'error',
            code: 'duplicate-name',
            message: `The tag or constant ${t.name} exists more than once in this PLC (also in ${distinct[0]!.file.relativePath}).`,
          });
        }
      }
    }
  }

  block(id: string): BlockSymbol | undefined {
    return this.blocksById.get(id);
  }

  /** Every symbol of a block id (duplicates included). */
  blocksNamed(namespace: string | undefined, name: string): BlockSymbol[] {
    return this.blocksByKey.get(key(namespace, name)) ?? [];
  }

  /**
   * A block by name as code refers to it. Inside a namespace an unqualified name means that
   * namespace first; the main program is searched as a fallback (never an error source).
   */
  findBlock(
    name: string,
    fromNamespace: string | undefined,
    explicitNamespace?: string | null,
  ): BlockSymbol | undefined {
    if (explicitNamespace !== undefined)
      return this.blocksNamed(explicitNamespace ?? undefined, name)[0];
    // "Ns.Name" written as one quoted identifier
    if (name.includes('.')) {
      const parts = name.replace(/^_\./, '').split('.');
      const last = parts.pop()!;
      const ns = parts.join('.');
      const hit = this.blocksNamed(ns || undefined, last)[0];
      if (hit) return hit;
    }
    return this.blocksNamed(fromNamespace, name)[0] ?? this.blocksNamed(undefined, name)[0];
  }

  findTag(name: string): TagSymbol | undefined {
    return this.tagsByName.get(name.replace(/^_\./, '').toLowerCase())?.[0];
  }

  /** The .s7res next to a .s7dcl. */
  resourcesFor(file: ProjectFile): ResourceFile | undefined {
    const resPath = joinPath(dirname(file.path), stem(file.path) + '.s7res');
    for (const [p, f] of this.project.files) {
      if (p.toLowerCase() === resPath.toLowerCase() && f.parsed?.kind === 'resources')
        return f.parsed;
    }
    return undefined;
  }

  /** OB attributes from the manifest, else from a SimaticML export next to the .s7dcl. */
  obInfo(symbol: BlockSymbol): ObInfo | undefined {
    if (symbol.kind !== 'OB') return undefined;
    if (this.obInfoCache.has(symbol.id)) return this.obInfoCache.get(symbol.id);
    const fromManifest = Object.entries(this.project.manifest?.obs ?? {}).find(
      ([n]) => n.toLowerCase() === symbol.name.toLowerCase(),
    )?.[1];
    let info: ObInfo | undefined;
    const base = joinPath(dirname(symbol.file.path), stem(symbol.file.path)).toLowerCase();
    for (const [p, f] of this.project.files) {
      const lp = p.toLowerCase();
      if (lp === base + '.xml' || lp === base + '.readonly.xml') {
        const read = readObAttributes(f.source.text);
        if (read)
          info = {
            ...read,
            ...info,
            ...(info?.priority === undefined && read.priority !== undefined
              ? { priority: read.priority }
              : {}),
          };
      }
    }
    const merged = fromManifest || info ? { ...info, ...fromManifest } : undefined;
    this.obInfoCache.set(symbol.id, merged);
    return merged;
  }

  // --- Types -------------------------------------------------------------------------------

  /** Resolves a declared type in the context of the block or type that declares it. */
  resolveType(
    node: TypeNode | undefined,
    fromNamespace: string | undefined,
    ownerId: string,
    file: string,
  ): DataType {
    if (!node) return UNKNOWN;
    switch (node.kind) {
      case 'error':
        return UNKNOWN;
      case 'string': {
        const info = this.project.profile.elementary(node.wide ? 'WString' : 'String');
        if (!info) return UNKNOWN;
        const len = node.length?.kind === 'literal' ? Number(node.length.text) : undefined;
        return {
          kind: 'elementary',
          name: info.name,
          info,
          length: Number.isFinite(len) ? len : undefined,
        };
      }
      case 'array': {
        const dims = node.dimensions.map((d) => ({
          lower:
            d.lower?.kind === 'literal'
              ? Number(d.lower.text)
              : d.lower?.kind === 'unary' && d.lower.operand.kind === 'literal'
                ? -Number(d.lower.operand.text)
                : undefined,
          upper: d.upper?.kind === 'literal' ? Number(d.upper.text) : undefined,
        }));
        return {
          kind: 'array',
          dimensions: dims,
          star: node.dimensions.some((d) => d.star),
          element: this.resolveType(node.element, fromNamespace, ownerId, file),
        };
      }
      case 'struct':
        return {
          kind: 'struct',
          members: this.structMembers(node.members, fromNamespace, ownerId, file),
        };
      case 'ref':
        return { kind: 'ref', target: this.resolveType(node.target, fromNamespace, ownerId, file) };
      case 'named':
        return this.resolveNamed(node, fromNamespace);
    }
  }

  private resolveNamed(node: NamedType, fromNamespace: string | undefined): DataType {
    const names = node.path.map((p) => p.text);
    const last = names[names.length - 1] ?? '';
    const single = names.length === 1 && !node.rooted;
    const quoted = node.path.some((p) => p.quoted);
    if (single && !quoted) {
      const elementary = this.project.profile.elementary(last);
      if (elementary) return { kind: 'elementary', name: elementary.name, info: elementary };
      const system = this.project.profile.systemType(last);
      if (system) return { kind: 'system', type: system };
    }
    const explicit =
      node.rooted || names.length > 1 ? names.slice(0, -1).join('.') || null : undefined;
    const block = this.findBlock(last, fromNamespace, explicit);
    if (block?.kind === 'UDT') return this.udtType(block);
    if (block?.kind === 'FB') return this.fbType(block);
    if (single && quoted) {
      const system = this.project.profile.systemType(last);
      if (system) return { kind: 'system', type: system };
    }
    return { kind: 'unknown', text: names.join('.') };
  }

  udtType(block: BlockSymbol): DataType {
    return {
      kind: 'udt',
      block,
      failsafe: block.failsafe,
      members: () =>
        this.cachedMembers(block.id, () =>
          this.structMembers(
            block.block.struct?.members ?? [],
            block.namespace,
            block.id,
            block.file.path,
          ),
        ),
    };
  }

  fbType(block: BlockSymbol): DataType {
    return {
      kind: 'fb',
      block,
      members: () =>
        this.interfaceMembers(block).filter(
          (m) =>
            m.section === 'Input' ||
            m.section === 'Output' ||
            m.section === 'InOut' ||
            m.section === 'Static',
        ),
    };
  }

  private cachedMembers(id: string, build: () => MemberInfo[]): MemberInfo[] {
    let m = this.memberCache.get(id);
    if (!m) {
      this.memberCache.set(id, []); // guards against recursive types
      m = build();
      this.memberCache.set(id, m);
    }
    return m;
  }

  private structMembers(
    members: readonly Member[],
    fromNamespace: string | undefined,
    ownerId: string,
    file: string,
    section?: SectionKind,
  ): MemberInfo[] {
    return members.map((m) => ({
      name: m.name.text,
      type: this.resolveType(
        m.type,
        fromNamespace,
        `${ownerId}/${m.name.text.toLowerCase()}`,
        file,
      ),
      section,
      id: memberId(ownerId, m.name.text),
      declaration: { file, range: m.name.range },
      node: m,
    }));
  }

  /** Every interface member of a block, in declaration order. */
  interfaceMembers(symbol: BlockSymbol): MemberInfo[] {
    return this.cachedMembers(`${symbol.id}#interface`, () => {
      const out: MemberInfo[] = [];
      for (const section of symbol.block.sections) {
        out.push(
          ...this.structMembers(
            section.members,
            symbol.namespace,
            symbol.id,
            symbol.file.path,
            section.kind,
          ),
        );
      }
      return out;
    });
  }

  /** The members a DB exposes: its own, its FB's (instance DB), or none (array DB). */
  dbMembers(symbol: BlockSymbol): readonly MemberInfo[] {
    if (symbol.dbKind === 'instance') {
      const t = this.resolveType(
        symbol.block.dbType,
        symbol.namespace,
        symbol.id,
        symbol.file.path,
      );
      if (t.kind === 'fb') return t.members();
      if (t.kind === 'system')
        return t.type.parameters.map((p) =>
          systemMember(symbol.id, p.name, this.project.profile, p.type),
        );
      return [];
    }
    if (symbol.dbKind === 'global') {
      if (symbol.block.struct)
        return this.structMembers(
          symbol.block.struct.members,
          symbol.namespace,
          symbol.id,
          symbol.file.path,
        );
      return this.interfaceMembers(symbol);
    }
    return [];
  }

  /** Type of a block used as a value: an instance DB or global DB. */
  dbType(symbol: BlockSymbol): DataType {
    if (symbol.dbKind === 'array')
      return this.resolveType(symbol.block.dbType, symbol.namespace, symbol.id, symbol.file.path);
    const members = this.dbMembers(symbol);
    return { kind: 'struct', members };
  }

  tagType(tag: TagSymbol): DataType {
    const name = tag.entry.dataType.replace(/^"|"$/g, '');
    const elementary = this.project.profile.elementary(name);
    if (elementary) return { kind: 'elementary', name: elementary.name, info: elementary };
    const stringMatch = /^(W?String)\s*\[\s*(\d+)\s*\]$/i.exec(name);
    if (stringMatch) {
      const info = this.project.profile.elementary(stringMatch[1]!)!;
      return { kind: 'elementary', name: info.name, info, length: Number(stringMatch[2]) };
    }
    const block = this.findBlock(name, undefined);
    if (block?.kind === 'UDT') return this.udtType(block);
    return { kind: 'unknown', text: name };
  }
}

export function memberId(ownerId: string, name: string): string {
  return `${ownerId.startsWith('member:') ? ownerId : 'member:' + ownerId.replace(/^block:/, '')}/${name.toLowerCase()}`;
}

export function systemMember(
  ownerId: string,
  name: string,
  profile: ProfileIndex,
  type: string,
): MemberInfo {
  const elementary = profile.elementary(type);
  return {
    name,
    type: elementary
      ? { kind: 'elementary', name: elementary.name, info: elementary }
      : { kind: 'generic', name: type },
    section: undefined,
    id: memberId(ownerId, name),
    declaration: undefined,
    node: undefined,
  };
}

export type { Range };
