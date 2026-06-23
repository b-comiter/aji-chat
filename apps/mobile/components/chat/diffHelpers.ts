/**
 * Pure helpers for rendering file-edit tool calls as inline diffs. Dependency-free
 * so it's unit-testable (see diffHelpers.test.ts) per the project's TDD rule.
 *
 * Tool results vary by agent. The preferred source is Claude Code's
 * `structuredPatch` (an array of unified-diff hunks); we fall back to
 * `oldString`/`newString` (Edit) or `content` (Write) when no patch is present.
 * Output is a single normalized shape the DiffCard renders, so a future
 * protocol-level diff field — or a Hermes adapter emitting the same data — slots
 * in without touching the view.
 */

export type DiffLineType = 'add' | 'del' | 'context'
export type DiffLine = { type: DiffLineType; text: string }
// `oldStart`/`newStart` are the 1-based line numbers the hunk begins at in the
// old and new file (from the unified-diff `@@` header). They let the viewer show
// real line numbers; absent for the old/new-string fallback, which starts at 1.
export type DiffHunk = { header?: string; oldStart?: number; newStart?: number; lines: DiffLine[] }
export type EditDiff = {
  filePath?: string
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

// Edit-producing tools, Claude Code + generic. Compared lower-cased.
const FILE_EDIT_TOOLS = new Set([
  'edit', 'write', 'multiedit', 'notebookedit',
  'edit_file', 'write_file', 'create_file', 'str_replace_based_edit_tool',
])

export function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name.trim().toLowerCase())
}

type AnyRecord = Record<string, unknown>

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : null
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return undefined
}

// Unified-diff line → classified line. structuredPatch lines carry a leading
// '+'/'-'/' ' marker; "\ No newline at end of file" entries are metadata.
function classifyPatchLine(raw: string): DiffLine | null {
  if (raw.startsWith('\\')) return null
  if (raw.startsWith('+')) return { type: 'add', text: raw.slice(1) }
  if (raw.startsWith('-')) return { type: 'del', text: raw.slice(1) }
  return { type: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw }
}

/**
 * Normalize a file-edit tool call into an EditDiff, or null if it isn't an edit
 * tool / carries no usable change data.
 */
export function parseEditDiff(name: string, args: AnyRecord, result: unknown): EditDiff | null {
  if (!isFileEditTool(name)) return null

  const res = asRecord(result)
  const filePath = pickString(
    res?.filePath, res?.file_path,
    args.file_path, args.filePath, args.path, args.targetPath,
  )

  // Preferred: Claude Code's structuredPatch.
  const structured = res?.structuredPatch
  if (Array.isArray(structured) && structured.length > 0) {
    const hunks: DiffHunk[] = []
    let additions = 0
    let deletions = 0
    for (const h of structured) {
      const hr = asRecord(h)
      const rawLines = Array.isArray(hr?.lines) ? hr!.lines : []
      const lines: DiffLine[] = []
      for (const rl of rawLines) {
        if (typeof rl !== 'string') continue
        const line = classifyPatchLine(rl)
        if (!line) continue
        if (line.type === 'add') additions++
        else if (line.type === 'del') deletions++
        lines.push(line)
      }
      if (lines.length === 0) continue
      const oldStart = typeof hr?.oldStart === 'number' ? hr.oldStart : undefined
      const newStart = typeof hr?.newStart === 'number' ? hr.newStart : undefined
      const header =
        oldStart !== undefined && newStart !== undefined
          ? `@@ -${oldStart} +${newStart} @@`
          : undefined
      hunks.push({ header, oldStart, newStart, lines })
    }
    if (hunks.length > 0) return { filePath, hunks, additions, deletions }
  }

  // Fallback: raw old/new strings (Edit) or content (Write/create).
  const oldString = pickString(res?.oldString, args.old_string, args.oldString) ?? ''
  const newString = pickString(res?.newString, args.new_string, args.newString, args.content) ?? ''
  if (oldString || newString) {
    const lines: DiffLine[] = []
    let additions = 0
    let deletions = 0
    if (oldString) for (const t of oldString.split('\n')) { lines.push({ type: 'del', text: t }); deletions++ }
    if (newString) for (const t of newString.split('\n')) { lines.push({ type: 'add', text: t }); additions++ }
    return { filePath, hunks: [{ oldStart: 1, newStart: 1, lines }], additions, deletions }
  }

  return null
}
