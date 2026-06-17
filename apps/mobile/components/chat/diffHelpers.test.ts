import { isFileEditTool, parseEditDiff } from './diffHelpers'

describe('isFileEditTool', () => {
  it('matches Claude Code and generic edit tools, case-insensitively', () => {
    for (const n of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit_file', 'create_file', 'str_replace_based_edit_tool']) {
      expect(isFileEditTool(n)).toBe(true)
    }
  })
  it('rejects non-edit tools', () => {
    for (const n of ['Read', 'Bash', 'Grep', 'web_search', 'glob']) {
      expect(isFileEditTool(n)).toBe(false)
    }
  })
})

describe('parseEditDiff', () => {
  it('returns null for non-edit tools', () => {
    expect(parseEditDiff('Read', { file_path: '/a' }, {})).toBeNull()
  })

  it('parses Claude Code structuredPatch (the Write example from the wire)', () => {
    const result = {
      filePath: '/Users/bcom/Desktop/temp2',
      structuredPatch: [
        {
          oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
          lines: ['+Hello World', '\\ No newline at end of file'],
        },
      ],
    }
    const diff = parseEditDiff('Write', { file_path: '/Users/bcom/Desktop/temp2', content: 'Hello World' }, result)
    expect(diff).not.toBeNull()
    expect(diff!.filePath).toBe('/Users/bcom/Desktop/temp2')
    expect(diff!.additions).toBe(1)
    expect(diff!.deletions).toBe(0)
    // The "\ No newline…" metadata line is dropped.
    expect(diff!.hunks[0].lines).toEqual([{ type: 'add', text: 'Hello World' }])
  })

  it('classifies +/-/context lines and counts them', () => {
    const result = {
      structuredPatch: [
        { oldStart: 10, newStart: 10, lines: [' ctx before', '-old line', '+new line', ' ctx after'] },
      ],
    }
    const diff = parseEditDiff('Edit', {}, result)!
    expect(diff.additions).toBe(1)
    expect(diff.deletions).toBe(1)
    expect(diff.hunks[0].lines).toEqual([
      { type: 'context', text: 'ctx before' },
      { type: 'del', text: 'old line' },
      { type: 'add', text: 'new line' },
      { type: 'context', text: 'ctx after' },
    ])
  })

  it('falls back to old_string/new_string when there is no structuredPatch', () => {
    const diff = parseEditDiff('Edit', { file_path: '/x', old_string: 'foo\nbar', new_string: 'baz' }, undefined)!
    expect(diff.deletions).toBe(2)
    expect(diff.additions).toBe(1)
    expect(diff.hunks[0].lines).toEqual([
      { type: 'del', text: 'foo' },
      { type: 'del', text: 'bar' },
      { type: 'add', text: 'baz' },
    ])
  })

  it('returns null when no change data is present', () => {
    expect(parseEditDiff('Write', {}, {})).toBeNull()
  })
})
