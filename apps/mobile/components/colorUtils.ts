// Shared color helpers. hexToRgba is used app-wide (markdown renderers, the
// audio bubble); LANG_COLORS / codeBgColor are markdown code-block specifics
// that live here to share the hexToRgba primitive.

// Brand colors for popular languages — used as the dot indicator in a code
// block header.
export const LANG_COLORS: Record<string, string> = {
  python:     '#3572A5',
  javascript: '#F7DF1E',
  js:         '#F7DF1E',
  typescript: '#3178C6',
  ts:         '#3178C6',
  rust:       '#DEA584',
  go:         '#00ADD8',
  ruby:       '#CC342D',
  java:       '#B07219',
  kotlin:     '#A97BFF',
  swift:      '#FA7343',
  'c++':      '#F34B7D',
  cpp:        '#F34B7D',
  c:          '#555555',
  'c#':       '#239120',
  csharp:     '#239120',
  php:        '#4F5D95',
  html:       '#E34C26',
  css:        '#563D7C',
  scss:       '#C6538C',
  sql:        '#336791',
  shell:      '#89E051',
  bash:       '#89E051',
  sh:         '#89E051',
  yaml:       '#CB171E',
  yml:        '#CB171E',
  json:       '#40BF8A',
  docker:     '#2496ED',
  dockerfile: '#2496ED',
  r:          '#198CE7',
  scala:      '#C22D40',
  elixir:     '#6E4A7E',
  haskell:    '#5E5086',
}

/** Convert a `#rrggbb` hex string to an `rgba(...)` string at the given alpha. */
export function hexToRgba(hex: string, alpha: number): string {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return `rgba(0, 0, 0, ${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Faint tinted code-block background derived from the language's brand color.
// Cached because the same handful of colors recur across every message.
const CODE_BG_CACHE: Record<string, string> = {}
export function codeBgColor(hex: string): string {
  const cached = CODE_BG_CACHE[hex]
  if (cached) return cached
  const rgba = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hexToRgba(hex, 0.08) : 'rgba(128, 128, 128, 0.08)'
  CODE_BG_CACHE[hex] = rgba
  return rgba
}
