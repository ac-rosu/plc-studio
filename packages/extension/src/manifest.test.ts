// The Marketplace rules from docs/SPEC.md ("Marketplace compliance"), checked on every test run.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_IDS } from './language-ids.ts';

const root = new URL('../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root));
const manifest = JSON.parse(read('package.json').toString('utf8')) as {
  name: string;
  displayName: string;
  description: string;
  version: string;
  publisher: string;
  license: string;
  icon: string;
  repository: { url: string };
  bugs: { url: string };
  homepage: string;
  engines: { vscode: string };
  keywords: string[];
  devDependencies: Record<string, string>;
  contributes: { languages: { id: string }[] };
};

const SIEMENS_MARKS = /siemens|simatic|step ?7|tia ?portal/i;
const versionTuple = (v: string) =>
  v
    .replace(/^[\^~]/, '')
    .split('.')
    .map(Number);

describe('extension manifest', () => {
  it('has publisher, license and https links', () => {
    expect(manifest.publisher).toBe('acro');
    expect(manifest.license).toBe('MIT');
    for (const url of [manifest.repository.url, manifest.bugs.url, manifest.homepage]) {
      expect(url).toMatch(/^https:\/\//);
    }
  });

  it('keeps Siemens trademarks out of name, display name and publisher', () => {
    for (const value of [manifest.name, manifest.displayName, manifest.publisher]) {
      expect(value).not.toMatch(SIEMENS_MARKS);
    }
  });

  it('uses a plain major.minor.patch version', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('declares engines.vscode as a caret range that covers @types/vscode', () => {
    expect(manifest.engines.vscode).toMatch(/^\^\d+\.\d+\.\d+$/);
    const [engMajor, engMinor] = versionTuple(manifest.engines.vscode);
    const [typesMajor, typesMinor] = versionTuple(manifest.devDependencies['@types/vscode'] ?? '');
    expect(typesMajor).toBe(engMajor);
    expect(typesMinor).toBeLessThanOrEqual(engMinor ?? 0);
  });

  it('has at most 30 keywords', () => {
    expect(manifest.keywords.length).toBeLessThanOrEqual(30);
  });

  it('has a PNG icon of at least 128x128 px', () => {
    const png = read(manifest.icon);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
  });

  it.each(['README.md', 'CHANGELOG.md'])('%s uses only https images and no SVG', (file) => {
    const text = read(file).toString('utf8');
    const images = [
      ...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g),
      ...text.matchAll(/<img[^>]+src="([^"]+)"/g),
    ];
    for (const [, url] of images) {
      expect(url).toMatch(/^https:\/\//);
      expect(url).not.toMatch(/\.svg(\?|$)/i);
    }
  });

  it('README carries the trademark, safety and privacy statements', () => {
    const text = read('README.md').toString('utf8');
    expect(text).toContain('not affiliated with or endorsed by Siemens');
    expect(text).toContain('not a safety-certified tool');
    expect(text).toContain('No telemetry');
  });

  it("registers exactly PLC Studio's own language ids (ADR 0009)", () => {
    // the read-only SCL of SimaticML exports is ours too, and never goes to the language server
    expect(manifest.contributes.languages.map((l) => l.id).sort()).toEqual(
      [...LANGUAGE_IDS, 'plcstudio-scl-readonly'].sort(),
    );
    expect(LANGUAGE_IDS).not.toContain('plcstudio-scl-readonly');
  });
});
