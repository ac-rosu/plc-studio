// SCL colors by role, in the spirit of the TIA Portal editor's defaults (owner, 2026-10-25): one
// color for every keyword, REGION apart, tags, constants, formal parameters and instructions each in
// their own. Our own values; the dark set keeps the roles apart on a dark background. The colors
// follow the theme (owner, 2026-10-25): a theme whose id contains "Light" gets the light set, every
// other theme the dark set. Used by the color defaults the extension contributes and by the SCL
// preview in the LAD/FBD view.

export const SYNTAX_ROLES = [
  'keyword',
  'region',
  'comment',
  'operator',
  'instruction',
  'literal',
  'constant',
  'tag',
  'parameter',
  'metadata',
] as const;

export type SyntaxRole = (typeof SYNTAX_ROLES)[number];

export const SYNTAX_COLORS: Record<'light' | 'dark', Record<SyntaxRole, string>> = {
  light: {
    keyword: '#0000FF',
    region: '#A61BD9',
    comment: '#1A7F2A',
    operator: '#404040',
    instruction: '#7A1A1A',
    literal: '#14668A',
    constant: '#123A66',
    tag: '#4B3F96',
    parameter: '#6B1A6B',
    metadata: '#6E6E6E',
  },
  dark: {
    keyword: '#569CD6',
    region: '#D98CFF',
    comment: '#7FB069',
    operator: '#AEAEAE',
    instruction: '#F28B82',
    literal: '#4EC9B0',
    constant: '#4FC1FF',
    // light blue, not violet: TIA's blue-violet reads as purple on a dark background (owner)
    tag: '#9CDCFE',
    // close to the text, as TIA's near-black formal parameters are on a light background
    parameter: '#D4C2E8',
    metadata: '#9A9A9A',
  },
};

/**
 * Themes whose id contains this get the light set (VS Code's Light 2026, Light Modern, Light+ and
 * most other light themes: Solarized Light, Monokai Pro Light …); all others the dark set.
 */
export const LIGHT_THEME_MARK = 'Light';
