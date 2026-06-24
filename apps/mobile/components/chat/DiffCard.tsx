/**
 * Inline rendered diff for a file-edit tool call (Option C): edits are shown as
 * a compact GitHub-style diff card in the chat flow rather than hidden behind the
 * tool-call sheet. Consumes the normalized EditDiff from diffHelpers, so it's
 * agnostic to which agent produced the change.
 */
import { memo, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { CodeViewerModal, CopyButton } from '../markdown/CodeViewerModal'
import type { ViewerRow } from '../markdown/CodeViewerModal'
import { highlightCodeLines, inferLanguageFromPath } from '../markdown/highlight'
import type { EditDiff, DiffLineType } from './diffHelpers'

// Lines shown inline before clipping to the expand action — keeps a big edit
// from dominating the scrollback on a phone. The full diff opens in a window.
const PREVIEW_LINES = 14

// `nodes` holds syntax-highlighted spans when the file extension resolves to a
// known grammar, else null (plain text, kept green/red for the add/del tint).
type FlatLine = { text: string; type: DiffLineType; hunkBreak: boolean; num: string; nodes: ReactNode[] | null }

function baseName(p?: string): string {
  if (!p) return 'file'
  const cleaned = p.replace(/\/+$/, '')
  return cleaned.split('/').pop() || cleaned
}

export const DiffCard = memo(function DiffCard({ diff }: { diff: EditDiff }) {
  const { colors, tokenColors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [collapsed, setCollapsed] = useState(true)
  const [viewerOpen, setViewerOpen] = useState(false)

  // Highlight by the edited file's extension (e.g. `.ts` → typescript).
  const lang = useMemo(() => inferLanguageFromPath(diff.filePath), [diff.filePath])

  // Flatten hunks into one line list, marking where a new hunk begins (for the
  // separator) and assigning each line its real file line number. Deletions show
  // the old-file number, additions/context the new-file number — one column.
  //
  // Each hunk side (new = context+add, old = context+del) is highlighted as a
  // block so multi-line constructs (strings, comments) parse correctly, then the
  // highlighted lines are zipped back onto the diff lines in order.
  const flat = useMemo<FlatLine[]>(() => {
    const out: FlatLine[] = []
    diff.hunks.forEach((h, hi) => {
      let oldNo = h.oldStart ?? 1
      let newNo = h.newStart ?? 1
      const newHl = lang ? highlightCodeLines(h.lines.filter((l) => l.type !== 'del').map((l) => l.text).join('\n'), lang, colors, tokenColors) : null
      const oldHl = lang ? highlightCodeLines(h.lines.filter((l) => l.type !== 'add').map((l) => l.text).join('\n'), lang, colors, tokenColors) : null
      let ni = 0
      let oi = 0
      h.lines.forEach((line, li) => {
        let num: string
        let nodes: ReactNode[] | null
        if (line.type === 'del') { num = String(oldNo); oldNo++; nodes = oldHl ? oldHl[oi++] ?? [] : null }
        else if (line.type === 'add') { num = String(newNo); newNo++; nodes = newHl ? newHl[ni++] ?? [] : null }
        else { num = String(newNo); oldNo++; newNo++; oi++; nodes = newHl ? newHl[ni++] ?? [] : null }
        out.push({ ...line, hunkBreak: hi > 0 && li === 0, num, nodes })
      })
    })
    return out
  }, [diff, lang, colors, tokenColors])

  const isTruncated = flat.length > PREVIEW_LINES
  const shown = isTruncated ? flat.slice(0, PREVIEW_LINES) : flat
  const hidden = flat.length - shown.length

  // Rows for the full-screen viewer: a real line number + the colored line.
  const viewerRows = useMemo<ViewerRow[]>(
    () =>
      flat.map((line) => ({
        gutter: line.num,
        gutterColor: line.type === 'add' ? colors.success : line.type === 'del' ? colors.danger : undefined,
        rowStyle: line.type === 'add' ? styles.lineAdd : line.type === 'del' ? styles.lineDel : undefined,
        content: (
          <Text
            style={[
              styles.viewerCode,
              !line.nodes && line.type === 'add' && styles.codeAdd,
              !line.nodes && line.type === 'del' && styles.codeDel,
            ]}
            selectable
          >
            {line.nodes ? (line.nodes.length ? line.nodes : ' ') : line.text.length ? line.text : ' '}
          </Text>
        ),
      })),
    [flat, styles, colors],
  )

  // Copy yields the new file content (everything that isn't a deletion).
  const newText = useMemo(
    () => flat.filter((l) => l.type !== 'del').map((l) => l.text).join('\n'),
    [flat],
  )

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Pressable
          onPress={() => setCollapsed((c) => !c)}
          style={styles.header}
          accessibilityRole="button"
          accessibilityLabel={collapsed ? 'Expand diff' : 'Collapse diff'}
        >
          <Feather name="edit-3" size={13} color={colors.tool} />
          <Text style={styles.fileName} numberOfLines={1}>{baseName(diff.filePath)}</Text>
          <View style={styles.stats}>
            {diff.additions > 0 && <Text style={styles.add}>+{diff.additions}</Text>}
            {diff.deletions > 0 && <Text style={styles.del}>−{diff.deletions}</Text>}
          </View>
          <Pressable
            onPress={() => setViewerOpen(true)}
            style={styles.expandBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Open full-screen viewer, ${flat.length} lines`}
          >
            <Feather name="maximize-2" size={13} color={colors.textMuted} />
            <Text style={styles.expandLabel}>{flat.length}</Text>
          </Pressable>
          <Feather
            name={collapsed ? 'chevron-down' : 'chevron-up'}
            size={13}
            color={colors.textMuted}
          />
        </Pressable>

        {!collapsed && (
          <>
            <View style={styles.body}>
              {shown.map((line, i) => (
                <View
                  key={i}
                  style={[
                    styles.line,
                    line.type === 'add' && styles.lineAdd,
                    line.type === 'del' && styles.lineDel,
                    line.hunkBreak && styles.hunkBreak,
                  ]}
                >
                  <Text
                    style={[
                      styles.gutter,
                      line.type === 'add' && styles.gutterAdd,
                      line.type === 'del' && styles.gutterDel,
                    ]}
                  >
                    {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
                  </Text>
                  <Text
                    style={[
                      styles.code,
                      !line.nodes && line.type === 'add' && styles.codeAdd,
                      !line.nodes && line.type === 'del' && styles.codeDel,
                    ]}
                  >
                    {line.nodes ? (line.nodes.length ? line.nodes : ' ') : line.text.length ? line.text : ' '}
                  </Text>
                </View>
              ))}
            </View>

            {isTruncated && (
              <Pressable onPress={() => setViewerOpen(true)} style={styles.moreBtn} hitSlop={6} accessibilityRole="button">
                <Text style={styles.moreText}>Show {hidden} more line{hidden === 1 ? '' : 's'}</Text>
              </Pressable>
            )}
          </>
        )}
      </View>

      {viewerOpen && (
        <CodeViewerModal
          title={baseName(diff.filePath)}
          badge={
            <View style={styles.stats}>
              {diff.additions > 0 && <Text style={styles.add}>+{diff.additions}</Text>}
              {diff.deletions > 0 && <Text style={styles.del}>−{diff.deletions}</Text>}
            </View>
          }
          actions={<CopyButton code={newText} />}
          rows={viewerRows}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </View>
  )
})

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { paddingVertical: spacing.sm, alignSelf: 'stretch' },
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      overflow: 'hidden',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: colors.surface2,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    fileName: {
      flex: 1,
      color: colors.text,
      fontFamily: typography.fontMono,
      fontSize: typography.sizeSm,
      fontWeight: typography.weightSemibold,
    },
    stats: { flexDirection: 'row', gap: spacing.sm },
    add: { color: colors.success, fontSize: typography.sizeSm, fontWeight: typography.weightSemibold, fontVariant: ['tabular-nums'] },
    del: { color: colors.danger, fontSize: typography.sizeSm, fontWeight: typography.weightSemibold, fontVariant: ['tabular-nums'] },
    // Mirrors CodeBlock's header: a maximize glyph + total line count that opens
    // the full-screen viewer.
    expandBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    expandLabel: { color: colors.textMuted, fontSize: typography.sizeXs, fontFamily: typography.fontMono },

    body: { paddingVertical: 4 },
    // A transparent left bar on every row so add/del can light it up without
    // shifting the code horizontally (Claude Code-style gutter accent).
    line: {
      flexDirection: 'row',
      paddingHorizontal: spacing.sm,
      paddingVertical: 1,
      borderLeftWidth: 2,
      borderLeftColor: 'transparent',
    },
    // Saturated tints (8-digit hex) over the surface — green/red bands that read
    // clearly on the dark theme, matching Claude Code's diff vibrancy.
    lineAdd: { backgroundColor: `${colors.success}33`, borderLeftColor: colors.success },
    lineDel: { backgroundColor: `${colors.danger}33`, borderLeftColor: colors.danger },
    hunkBreak: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 2, paddingTop: 2 },
    gutter: {
      width: 12,
      color: colors.textDim,
      fontFamily: typography.fontMono,
      fontSize: typography.sizeXs,
      lineHeight: 18,
    },
    // Bold, fully-saturated +/− signs so the change direction pops.
    gutterAdd: { color: colors.success, fontWeight: typography.weightBold },
    gutterDel: { color: colors.danger, fontWeight: typography.weightBold },
    code: {
      flex: 1,
      color: colors.text,
      fontFamily: typography.fontMono,
      fontSize: typography.sizeXs,
      lineHeight: 18,
    },
    // Color the changed line's text too, the way Claude Code renders diffs.
    codeAdd: { color: colors.success },
    codeDel: { color: colors.danger },
    // Line body inside the full-screen viewer — larger than the inline preview;
    // CodeViewerModal owns the row layout (gutter, accent bar, scroll).
    viewerCode: {
      color: colors.text,
      fontFamily: typography.fontMono,
      fontSize: typography.sizeMd,
      lineHeight: typography.lineHeightCode,
    },

    moreBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    moreText: { color: colors.accent, fontSize: typography.sizeSm, fontWeight: typography.weightSemibold },
  })
}
