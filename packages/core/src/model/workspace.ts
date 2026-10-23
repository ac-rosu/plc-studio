// The PLC folders of a workspace. Each folder with a plc.json is its own project; files outside
// every PLC folder are checked for syntax only (spec, "PLC folder and manifest").
import { fileKindOf } from '../formats/document.ts';
import { SourceText } from '../text/source-text.ts';
import { basename, dirname, isInside, joinPath, normalizePath } from './paths.ts';
import { Project } from './project.ts';
import { parseRulesConfig, type RulesConfigInput } from '../analyzer/config.ts';

/** File access the extension (or a test) provides; core never touches the disk itself. */
export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  /** Entries of a folder: name and whether it is a folder. */
  readDirectory(path: string): Promise<[name: string, isDirectory: boolean][]>;
}

const SKIP_FOLDERS = new Set(['node_modules', '.git', '.vscode', '.vscode-test', 'dist', 'out']);

export function isPlcFile(path: string): boolean {
  const kind = fileKindOf(path);
  return kind === 's7dcl' || kind === 's7res' || kind === 'source' || kind === 'tagTable';
}

export class Workspace {
  readonly projects = new Map<string, Project>();
  /** Files outside every PLC folder: syntax only. */
  readonly loose = new Project('');
  /** Workspace-level plcstudio.rules.json files (outside every PLC folder), by folder. */
  private readonly workspaceRules = new Map<string, Partial<RulesConfigInput>>();

  /** Finds plc.json files and loads every PLC file below the given folders. */
  async scan(fs: FileSystem, folders: readonly string[]): Promise<void> {
    const manifests: string[] = [];
    const rules: string[] = [];
    const files: string[] = [];
    const walk = async (folder: string, depth: number) => {
      if (depth > 12) return;
      let entries: [string, boolean][];
      try {
        entries = await fs.readDirectory(folder);
      } catch {
        return;
      }
      for (const [name, isDirectory] of entries) {
        const path = joinPath(folder, name);
        if (isDirectory) {
          if (!SKIP_FOLDERS.has(name) && !name.startsWith('.')) await walk(path, depth + 1);
        } else if (name.toLowerCase() === 'plc.json') {
          manifests.push(path);
        } else if (name.toLowerCase() === 'plcstudio.rules.json') {
          rules.push(path);
        } else if (isPlcFile(path)) {
          files.push(path);
        }
      }
    };
    for (const f of folders) await walk(normalizePath(f), 0);
    for (const m of manifests) {
      const text = new TextDecoder('utf-8').decode(await fs.readFile(m));
      this.setManifest(m, text);
    }
    for (const r of rules) {
      try {
        this.setRules(r, new TextDecoder('utf-8').decode(await fs.readFile(r)));
      } catch {
        // unreadable rules files are skipped
      }
    }
    for (const f of files) {
      try {
        this.setFileBytes(f, await fs.readFile(f));
      } catch {
        // unreadable files are skipped
      }
    }
  }

  /** The project a path belongs to: the deepest PLC folder containing it. */
  projectFor(path: string): Project {
    let best: Project | undefined;
    for (const p of this.projects.values()) {
      if (isInside(path, p.root) && (!best || p.root.length > best.root.length)) best = p;
    }
    return best ?? this.loose;
  }

  setManifest(path: string, text: string): Project {
    const root = dirname(normalizePath(path));
    let project = this.projects.get(root.toLowerCase());
    if (!project) {
      project = new Project(root);
      this.projects.set(root.toLowerCase(), project);
      // move files that now belong to this project
      for (const [p, f] of [...this.loose.files]) {
        if (isInside(p, root)) {
          project.setFile(p, f.source);
          this.loose.removeFile(p);
        }
      }
      for (const other of this.projects.values()) {
        if (other === project || !isInside(root, other.root)) continue;
        for (const [p, f] of [...other.files]) {
          if (isInside(p, root)) {
            project.setFile(p, f.source);
            other.removeFile(p);
          }
        }
      }
    }
    project.setManifest(path, text);
    this.applyWorkspaceRules(project);
    return project;
  }

  removeManifest(path: string): void {
    const root = dirname(normalizePath(path)).toLowerCase();
    const project = this.projects.get(root);
    if (!project) return;
    this.projects.delete(root);
    for (const [p, f] of project.files) this.projectFor(p).setFile(p, f.source);
  }

  setFileBytes(path: string, bytes: Uint8Array): void {
    this.setFileSource(path, SourceText.fromBytes(bytes));
  }

  setFileText(path: string, text: string): void {
    const project = this.projectFor(path);
    const old = project.files.get(normalizePath(path));
    this.setFileSource(path, new SourceText(text, old?.source.bom ?? false));
  }

  /** A plcstudio.rules.json: of a PLC folder when it sits in one, otherwise of the workspace. */
  setRules(path: string, text: string | undefined): void {
    const folder = dirname(normalizePath(path));
    const project = this.projects.get(folder.toLowerCase());
    if (project) {
      project.setRules(path, text);
      return;
    }
    if (text === undefined) this.workspaceRules.delete(folder.toLowerCase());
    else this.workspaceRules.set(folder.toLowerCase(), parseRulesConfig(text).config);
    for (const p of this.allProjects()) this.applyWorkspaceRules(p);
  }

  /** The nearest workspace-level rules file above a project applies to it. */
  private applyWorkspaceRules(project: Project): void {
    let best: string | undefined;
    for (const folder of this.workspaceRules.keys()) {
      const applies = project.root === '' || isInside(project.root, folder);
      if (applies && (!best || folder.length > best.length)) best = folder;
    }
    project.setWorkspaceRules(best ? this.workspaceRules.get(best) : undefined);
  }

  setFileSource(path: string, source: SourceText): void {
    if (basename(path).toLowerCase() === 'plcstudio.rules.json') {
      this.setRules(path, source.text);
      return;
    }
    if (basename(path).toLowerCase() === 'plc.json') {
      this.setManifest(path, source.text);
      return;
    }
    this.projectFor(path).setFile(path, source);
  }

  removeFile(path: string): void {
    if (basename(path).toLowerCase() === 'plcstudio.rules.json') {
      this.setRules(path, undefined);
      return;
    }
    if (basename(path).toLowerCase() === 'plc.json') {
      this.removeManifest(path);
      return;
    }
    this.projectFor(path).removeFile(path);
  }

  allProjects(): Project[] {
    return [...this.projects.values(), this.loose];
  }
}
