import { describe, expect, it } from 'vitest';
import { SYNTAX_COLORS, SYNTAX_ROLES } from './colors.ts';

// WCAG relative luminance and contrast ratio
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('syntax colors', () => {
  // editor backgrounds: VS Code's Light 2026/Modern/+, Dark Modern, Dark+, Dark 2026, and common dark
  // themes (Monokai Pro, Monokai, One Dark), as every dark theme gets the dark set
  it.each([
    ['light', '#FFFFFF'],
    ['dark', '#1F1F1F'],
    ['dark', '#1E1E1E'],
    ['dark', '#121314'],
    ['dark', '#2D2A2E'],
    ['dark', '#272822'],
    ['dark', '#282C34'],
  ] as const)('%s colors are readable on %s (WCAG AA, 4.5:1)', (kind, background) => {
    for (const role of SYNTAX_ROLES)
      expect(contrast(SYNTAX_COLORS[kind][role], background), role).toBeGreaterThanOrEqual(4.5);
  });

  it('gives every role a color of its own', () => {
    for (const kind of ['light', 'dark'] as const)
      expect(new Set(Object.values(SYNTAX_COLORS[kind])).size).toBe(SYNTAX_ROLES.length);
  });
});
