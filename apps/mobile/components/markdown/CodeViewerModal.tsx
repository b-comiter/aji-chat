/**
 * Shared full-screen "window" for viewing monospace content — used by both the
 * markdown CodeBlock and the chat DiffCard. It owns the chrome those two have in
 * common (the slide-up Modal, the safe-area header with a title + action slots +
 * close, a pinned line-number gutter, and dual-axis scroll), while each caller
 * supplies its own rows (highlighted code vs. a colored diff).
 *
 * Composition over inheritance: CodeBlock and DiffCard stay thin and render
 * domain-specific lines into this presentational shell rather than sharing one
 * over-conditional component.
 */
import * as Clipboard from 'expo-clipboard'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { StyleProp, ViewStyle } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing, typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { useTheme } from '../../context/ThemeContext'

// ---------------------------------------------------------------------------
// CopyButton — copies `code` to the clipboard, flips to a "Copied" state for 2s.
// Lives here (rather than in CodeBlock) so both the code and diff viewers reuse it.
// ---------------------------------------------------------------------------
export function CopyButton({ code }: { code: string }) {
  const { colors } = useTheme()
  const [copied, setCopied] = useState(false)
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current)
    }
  }, [])

  async function handlePress() {
    await Clipboard.setStringAsync(code)
    setCopied(true)
    if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current)
    resetTimeoutRef.current = setTimeout(() => {
      setCopied(false)
      resetTimeoutRef.current = null
    }, 2000)
  }

  const tint = copied ? '#40BF8A' : colors.textMuted

  return (
    <Pressable onPress={handlePress} style={copyBtnStyles.btn} hitSlop={8}>
      <Feather name={copied ? 'check' : 'copy'} size={14} color={tint} />
      <Text style={[copyBtnStyles.label, { color: tint }]}>{copied ? 'Copied' : 'Copy'}</Text>
    </Pressable>
  )
}

const copyBtnStyles = StyleSheet.create({
  btn:   { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { fontSize: typography.sizeXs },
})

// One rendered line in the viewer.
export type ViewerRow = {
  /** Gutter label (line number). Blank string → an empty gutter cell. */
  gutter?: string
  /** Optional gutter color override (e.g. green/red on a diff). */
  gutterColor?: string
  /** The line body — a <Text> the caller styles (mono font, color, etc.). */
  content: ReactNode
  /** Optional per-row background + left accent (diff add/del tint). */
  rowStyle?: StyleProp<ViewStyle>
}

// ---------------------------------------------------------------------------
// CodeViewerModal — full-screen viewer. The line-number gutter sits outside the
// horizontal ScrollView so it stays pinned while code scrolls sideways, but
// inside the vertical ScrollView so it scrolls up/down with the code. Gutter and
// line bodies share one lineHeight so numbers stay aligned with their rows.
// ---------------------------------------------------------------------------
export function CodeViewerModal({
  title,
  badge,
  actions,
  rows,
  onClose,
}: {
  title: string
  /** Optional node beside the title (e.g. a diff's +N −N stats). */
  badge?: ReactNode
  /** Optional node before the close button (e.g. a CopyButton). */
  actions?: ReactNode
  rows: ViewerRow[]
  onClose: () => void
}) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const styles = useMemo(() => makeViewerStyles(colors), [colors])

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {badge}
          {actions}
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={styles.closeBtn}
          >
            <Feather name="x" size={24} color={colors.text} />
          </Pressable>
        </View>
        <ScrollView style={styles.vScroll} contentContainerStyle={styles.vContent}>
          <View style={styles.codeRow}>
            <View style={styles.gutter}>
              {rows.map((r, i) => (
                <Text
                  key={i}
                  style={[styles.gutterText, r.gutterColor ? { color: r.gutterColor } : null]}
                  selectable={false}
                >
                  {r.gutter ?? ''}
                </Text>
              ))}
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator style={styles.hScroll}>
              <View style={styles.codeLines}>
                {rows.map((r, i) => (
                  <View key={i} style={[styles.lineRow, r.rowStyle]}>
                    {r.content}
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>
        </ScrollView>
      </View>
    </Modal>
  )
}

function makeViewerStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    title: {
      flex: 1,
      color: colors.text,
      fontSize: typography.sizeLg,
      fontFamily: typography.fontMono,
      fontWeight: typography.weightSemibold,
    },
    closeBtn: { padding: spacing.xs },
    vScroll: { flex: 1 },
    vContent: { paddingVertical: spacing.lg },
    codeRow: { flexDirection: 'row' },
    gutter: {
      paddingLeft: spacing.lg,
      paddingRight: 12,
      alignItems: 'flex-end',
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: colors.border,
    },
    // Same lineHeight as a line body so each number aligns with its row even
    // though the digits are smaller and muted.
    gutterText: {
      fontFamily: typography.fontMono,
      fontSize: typography.sizeSm,
      lineHeight: typography.lineHeightCode,
      color: colors.textDim,
    },
    hScroll: { flex: 1 },
    codeLines: { paddingRight: spacing.lg },
    // Each row carries a transparent left accent so diff add/del can light it up
    // without shifting the text; the left padding sits after that bar.
    lineRow: {
      borderLeftWidth: 2,
      borderLeftColor: 'transparent',
      paddingLeft: 12,
    },
  })
}
