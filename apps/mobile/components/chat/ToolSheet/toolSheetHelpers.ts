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

export type ToolPreview = {
  label: string
  text: string
}

type ToolArgs = Record<string, unknown>

export function getToolPreview(
  toolName: string,
  args: ToolArgs,
  result: unknown,
  done: boolean,
): ToolPreview {
  const name = toolName.toLowerCase()

  const byTool = pickPreviewByTool(name, args, result, done)
  if (byTool) return byTool

  const genericTarget =
    firstString(args, [
      'filePath',
      'path',
      'targetPath',
      'directory',
      'includePattern',
      'glob',
      'url',
      'query',
      'command',
    ]) ?? firstStringFromResult(result)

  if (genericTarget) {
    return {
      label: done ? 'File' : 'Target',
      text: smartDisplay(genericTarget),
    }
  }

  const fallbackSource = done && result !== undefined ? result : args
  return {
    label: done ? 'Result' : 'Args',
    text:
      done && result === undefined
        ? 'Completed with no result payload'
        : summarizeJson(fallbackSource),
  }
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

function pickPreviewByTool(
  name: string,
  args: ToolArgs,
  result: unknown,
  done: boolean,
): ToolPreview | null {
  if (name === 'read_file') {
    return {
      label: 'Read',
      text: smartDisplay(firstString(args, ['filePath', 'path']) ?? summarizeJson(args)),
    }
  }

  if (name === 'create_file') {
    return {
      label: 'Created',
      text: smartDisplay(firstString(args, ['filePath', 'path']) ?? summarizeJson(args)),
    }
  }

  if (name === 'write_file') {
    return {
      label: 'Wrote',
      text: smartDisplay(firstString(args, ['filePath', 'path']) ?? summarizeJson(args)),
    }
  }

  if (name === 'delete_file') {
    return {
      label: 'Deleted',
      text: smartDisplay(firstString(args, ['filePath', 'path']) ?? summarizeJson(args)),
    }
  }

  if (name === 'edit_file' || name === 'str_replace_based_edit_tool') {
    const path = firstString(args, ['filePath', 'path'])
    const changes =
      firstNumber(args, ['replacementCount', 'changes', 'matches']) ??
      firstNumberFromResult(result)
    const suffix = changes !== null ? ` (${changes} change${changes === 1 ? '' : 's'})` : ''
    return {
      label: 'Edited',
      text: `${smartDisplay(path ?? summarizeJson(args))}${suffix}`,
    }
  }

  if (name === 'glob') {
    return {
      label: 'Matched',
      text: smartDisplay(firstString(args, ['pattern', 'glob', 'query']) ?? summarizeJson(args)),
    }
  }

  if (name === 'grep') {
    const query = firstString(args, ['query'])
    const include = firstString(args, ['includePattern'])
    if (query && include) {
      return { label: 'Searched', text: smartDisplay(`${query} in ${include}`) }
    }
    return {
      label: 'Searched',
      text: smartDisplay(query ?? include ?? summarizeJson(args)),
    }
  }

  if (name === 'list_directory') {
    return {
      label: 'Listed',
      text: smartDisplay(firstString(args, ['path', 'directory']) ?? summarizeJson(args)),
    }
  }

  if (name === 'web_fetch') {
    return {
      label: 'Fetched',
      text: smartDisplay(firstString(args, ['url']) ?? summarizeJson(args)),
    }
  }

  if (name === 'web_search') {
    return {
      label: 'Searched Web',
      text: smartDisplay(firstString(args, ['query']) ?? summarizeJson(args)),
    }
  }

  if (name === 'bash' || name === 'terminal' || name === 'python' || name === 'execute_code') {
    const command =
      firstString(args, ['command', 'codeSnippet', 'code']) ??
      (done ? firstStringFromResult(result) : null)
    return {
      label: name === 'python' || name === 'execute_code' ? 'Executed' : 'Ran',
      text: smartDisplay(command ?? summarizeJson(done ? result : args)),
    }
  }

  return null
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      const first = String(value[0])
      const more = value.length - 1
      return more > 0 ? `${first} +${more} more` : first
    }
  }
  return null
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function firstStringFromResult(result: unknown): string | null {
  const normalized = parseJsonString(result)
  if (typeof normalized === 'string' && normalized.trim()) return normalized

  if (normalized && typeof normalized === 'object') {
    const asRecord = normalized as Record<string, unknown>
    return firstString(asRecord, [
      'filePath',
      'path',
      'targetPath',
      'directory',
      'url',
      'query',
      'command',
      'message',
      'summary',
      'output',
    ])
  }

  return null
}

function firstNumberFromResult(result: unknown): number | null {
  const normalized = parseJsonString(result)
  if (!normalized || typeof normalized !== 'object') return null
  return firstNumber(normalized as Record<string, unknown>, ['replacementCount', 'changes', 'matches'])
}

function smartDisplay(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return value

  const noScheme = trimmed.replace(/^https?:\/\//i, '')
  return truncateInline(noScheme, 88)
}

function truncateInline(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxLength) return singleLine
  return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}
