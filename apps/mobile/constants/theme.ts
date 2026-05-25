export const colors = {
  // Backgrounds — mirrors mobile-mockup.html :root CSS variables
  bg:         '#0d1117',   // --bg
  surface:    '#161b22',   // --surface
  surface2:   '#1c2129',   // --surface-2
  surface3:   '#242b35',   // --surface-3

  // Borders
  border:     '#21262d',   // primary divider (native-derived; mockup: #2a3038)
  borderAlt:  '#3a424d',   // secondary / input borders
  borderCode: '#30363d',   // code block border (MarkdownMessage only)

  // Text
  text:       '#e6edf3',   // --text
  textMuted:  '#8b949e',   // --text-muted
  textDim:    '#6e7681',   // --text-dim
  textFaint:  '#3d444d',   // chevrons / empty glyphs (native-only, no CSS var)

  // Accent
  accent:     '#5e8eff',   // --accent
  accentDim:  '#2d4380',   // --accent-dim

  // Semantic
  success:    '#3fb950',   // --success
  warn:       '#d29922',   // --warn
  danger:     '#f85149',   // --danger

  // Tool / AI
  tool:       '#b392f0',   // --tool
  toolDim:    '#4c3b73',   // --tool-dim
} as const

// Syntax highlighting token colors — design tokens, not language brand colors.
// LANG_COLORS (language brand dots) stays local to MarkdownMessage.
export const tokenColors: Record<string, string> = {
  keyword:     '#ff6b6b',
  built_in:    '#61afef',
  literal:     '#61afef',
  number:      '#d19a66',
  string:      '#98c379',
  attr:        '#56b6c2',
  function:    '#c678dd',
  class:       '#e5c07b',
  comment:     '#6a737d',
  punctuation: '#c9d1d9',
  operator:    '#ff6b6b',
  variable:    '#e6edf3',
  title:       '#c678dd',
  section:     '#61afef',
  meta:        '#56b6c2',
  symbol:      '#d16d9e',
  name:        '#e5c07b',
}

export const typography = {
  fontMono: 'Menlo',

  sizeXs:   11,
  sizeSm:   12,
  sizeMd:   13,
  size:     14,
  sizeLg:   15,
  sizeXl:   17,
  size2xl:  20,

  // Numeric weight strings work for system fonts (SF Pro, Roboto, Menlo).
  // If switching to custom Google Fonts later, map these to explicit family
  // variants (e.g. 'Inter-Regular') rather than relying on weight strings.
  weightRegular:  '400' as const,
  weightMedium:   '500' as const,
  weightSemibold: '600' as const,
  weightBold:     '700' as const,

  lineHeightNormal: 22,
  lineHeightCode:   20,
} as const

export const spacing = {
  xs:   4,
  sm:   8,
  md:   12,
  lg:   16,
  xl:   20,
  xxl:  24,
  xxxl: 32,
} as const

export const radius = {
  sm:   4,
  md:   8,
  lg:   12,
  xl:   14,
  full: 999,
} as const
