/**
 * Inline rendered diff for a file-edit tool call (Option C): edits are shown as
 * a compact GitHub-style diff card in the chat flow rather than hidden behind the
 * tool-call sheet. Consumes the normalized EditDiff from diffHelpers, so it's
 * agnostic to which agent produced the change.
 */
import { memo, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { EditDiff } from './diffHelpers'

// Lines shown before collapsing behind a "show more" toggle — keeps a big edit
// from dominating the scrollback on a phone.
const COLLAPSED_MAX_LINES = 14

function baseName(p?: string): string {
  if (!p) return 'file'
  const cleaned = p.replace(/\/+$/, '')
  return cleaned.split('/').pop() || cleaned
}

export const DiffCard = memo(function DiffCard({ diff }: { diff: EditDiff }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [expanded, setExpanded] = useState(false)

  // Flatten hunks into a single line list, marking where a new hunk begins so we
  // can draw a separator between non-contiguous regions.
  const flat = useMemo(() => {
    const out: { text: string; type: EditDiff['hunks'][number]['lines'][number]['type']; hunkBreak: boolean }[] = []
    diff.hunks.forEach((h, hi) => {
      h.lines.forEach((line, li) => out.push({ ...line, hunkBreak: hi > 0 && li === 0 }))
    })
    return out
  }, [diff])

  const collapsed = !expanded && flat.length > COLLAPSED_MAX_LINES
  const shown = collapsed ? flat.slice(0, COLLAPSED_MAX_LINES) : flat
  const hidden = flat.length - shown.length

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <View style={styles.header}>
          <Feather name="edit-3" size={13} color={colors.tool} />
          <Text style={styles.fileName} numberOfLines={1}>{baseName(diff.filePath)}</Text>
          <View style={styles.stats}>
            {diff.additions > 0 && <Text style={styles.add}>+{diff.additions}</Text>}
            {diff.deletions > 0 && <Text style={styles.del}>−{diff.deletions}</Text>}
          </View>
        </View>

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
              <Text style={styles.gutter}>
                {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
              </Text>
              <Text style={styles.code}>{line.text.length ? line.text : ' '}</Text>
            </View>
          ))}
        </View>

        {collapsed && (
          <Pressable onPress={() => setExpanded(true)} style={styles.moreBtn} hitSlop={6} accessibilityRole="button">
            <Text style={styles.moreText}>Show {hidden} more line{hidden === 1 ? '' : 's'}</Text>
          </Pressable>
        )}
      </View>
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
    add: { color: colors.success, fontSize: typography.sizeSm, fontVariant: ['tabular-nums'] },
    del: { color: colors.danger, fontSize: typography.sizeSm, fontVariant: ['tabular-nums'] },

    body: { paddingVertical: 4 },
    line: { flexDirection: 'row', paddingHorizontal: spacing.sm, paddingVertical: 1 },
    // Low-opacity tints (8-digit hex) over the surface, GitHub-style.
    lineAdd: { backgroundColor: `${colors.success}22` },
    lineDel: { backgroundColor: `${colors.danger}22` },
    hunkBreak: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 2, paddingTop: 2 },
    gutter: {
      width: 12,
      color: colors.textDim,
      fontFamily: typography.fontMono,
      fontSize: typography.sizeXs,
      lineHeight: 18,
    },
    code: {
      flex: 1,
      color: colors.text,
      fontFamily: typography.fontMono,
      fontSize: typography.sizeXs,
      lineHeight: 18,
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
