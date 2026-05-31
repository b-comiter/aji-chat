/**
 * Pure helpers used by ToolSheet. Lives in its own file so tests can import
 * without dragging in React Native / Expo modules — the rule for any code
 * that wants unit-test coverage.
 */

// ---------------------------------------------------------------------------
// Tool name → emoji icon (fallback: 🔧)
// ---------------------------------------------------------------------------
export const TOOL_ICONS: Record<string, string> = {
  bash:                        '💻',
  computer:                    '🖥️',
  read_file:                   '📖',
  write_file:                  '✍️',
  str_replace_based_edit_tool: '✏️',
  edit_file:                   '✏️',
  create_file:                 '📄',
  delete_file:                 '🗑️',
  web_search:                  '🔍',
  web_fetch:                   '🌐',
  python:                      '🐍',
  execute_code:                '🐍',
  terminal:                    '💻',
  list_directory:              '📂',
  glob:                        '🔎',
  grep:                        '🔎',
  cronjob:                     '⏰',
}

export function toolIcon(name: string): string {
  return TOOL_ICONS[name.toLowerCase()] ?? '🔧'
}

export function summarizeJson(value: unknown, maxLength = 88): string {
  const normalizedValue = parseJsonString(value)

  if (typeof normalizedValue === 'string') {
    return truncateInline(normalizedValue, maxLength)
  }

  try {
    const out = JSON.stringify(normalizedValue)
    return truncateInline(out ?? String(value), maxLength)
  } catch {
    return truncateInline(String(value), maxLength)
  }
}

/**
 * Pretty-print a value as 2-space-indented JSON. Falls back to `String(value)`
 * if stringify throws (e.g. circular refs).
 */
export function formatJson(value: unknown): string {
  const normalizedValue = parseJsonString(value)

  try {
    // JSON.stringify(undefined) returns undefined (not 'undefined'), which
    // would crash any <Text> consumer. Coerce to a guaranteed string.
    const out = JSON.stringify(normalizedValue, null, 2)
    return out ?? String(value)
  } catch {
    return String(value)
  }
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value

  const trimmed = value.trim()
  if (!trimmed) return value

  const startsLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[')
  if (!startsLikeJson) return value

  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function truncateInline(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxLength) return singleLine
  return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}
