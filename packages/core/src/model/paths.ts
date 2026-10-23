// Paths in core are strings with '/' separators, as the extension provides them. Core never
// touches the disk (ADR 0006).

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function dirname(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i <= 0 ? (i === 0 ? '/' : '') : p.slice(0, i);
}

export function basename(path: string): string {
  const p = normalizePath(path);
  return p.slice(p.lastIndexOf('/') + 1);
}

export function stem(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

export function extname(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((p) => p !== '').join('/'));
}

/** True when `path` is `folder` or inside it (case-insensitive, as on Windows). */
export function isInside(path: string, folder: string): boolean {
  const p = normalizePath(path).toLowerCase();
  const f = normalizePath(folder).toLowerCase();
  return p === f || p.startsWith(f + '/');
}

export function relativePath(from: string, to: string): string {
  const f = normalizePath(from);
  const t = normalizePath(to);
  return isInside(t, f) ? t.slice(f.length).replace(/^\//, '') : t;
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}
