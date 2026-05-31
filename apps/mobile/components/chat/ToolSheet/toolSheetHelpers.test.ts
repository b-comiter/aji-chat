import { formatJson, summarizeJson, toolIcon } from './toolSheetHelpers'

describe('toolIcon', () => {
  test('returns the mapped icon for a known tool name', () => {
    expect(toolIcon('bash')).toBe('💻')
    expect(toolIcon('python')).toBe('🐍')
    expect(toolIcon('web_search')).toBe('🔍')
  })

  test('is case-insensitive on the input name', () => {
    expect(toolIcon('Bash')).toBe('💻')
    expect(toolIcon('READ_FILE')).toBe('📖')
  })

  test('falls back to 🔧 for unknown tool names', () => {
    expect(toolIcon('totally_made_up_tool')).toBe('🔧')
    expect(toolIcon('')).toBe('🔧')
  })

  test('treats aliased names independently (terminal == bash icon)', () => {
    // Both terminal and bash map to 💻 — guards against the table being
    // accidentally de-duplicated.
    expect(toolIcon('terminal')).toBe(toolIcon('bash'))
  })
})

describe('formatJson', () => {
  test('pretty-prints objects with 2-space indent', () => {
    const out = formatJson({ a: 1, b: 'two' })
    expect(out).toBe(`{
  "a": 1,
  "b": "two"
}`)
  })

  test('handles primitives', () => {
    expect(formatJson('hi')).toBe('"hi"')
    expect(formatJson(42)).toBe('42')
    expect(formatJson(null)).toBe('null')
    expect(formatJson(true)).toBe('true')
  })

  test('returns the literal string "undefined" for undefined input', () => {
    // JSON.stringify(undefined) returns undefined (not a string), so the
    // fallback String() path handles it. Documents the actual behavior.
    expect(formatJson(undefined)).toBe('undefined')
  })

  test('parses JSON object strings before pretty-printing them', () => {
    expect(formatJson('{"a":1,"b":[2,3]}')).toBe(`{
  "a": 1,
  "b": [
    2,
    3
  ]
}`)
  })

  test('leaves non-JSON strings as strings', () => {
    expect(formatJson('plain text output')).toBe('"plain text output"')
  })

  test('falls back to String() on circular refs instead of throwing', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(() => formatJson(a)).not.toThrow()
    // Whatever String(a) yields (typically "[object Object]") is fine — the
    // important contract is no throw.
    expect(typeof formatJson(a)).toBe('string')
  })
})

describe('summarizeJson', () => {
  test('renders objects as compact single-line JSON', () => {
    expect(summarizeJson({ a: 1, b: ['x', 'y'] })).toBe('{"a":1,"b":["x","y"]}')
  })

  test('parses JSON strings before compact formatting', () => {
    expect(summarizeJson('{"ok":true,"count":2}')).toBe('{"ok":true,"count":2}')
  })

  test('preserves plain text strings', () => {
    expect(summarizeJson('command completed successfully')).toBe('command completed successfully')
  })

  test('truncates long output for inline previews', () => {
    expect(summarizeJson({ text: 'abcdefghijklmnopqrstuvwxyz' }, 18)).toBe('{"text":"abcdefgh…')
  })
})
