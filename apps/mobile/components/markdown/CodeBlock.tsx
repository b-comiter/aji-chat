import * as Clipboard from 'expo-clipboard'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing, typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { useTheme } from '../../context/ThemeContext'
import { LANG_COLORS, codeBgColor } from '../colorUtils'
import { highlightCodeLines, inferLanguage } from './highlight'

// Whether code blocks render selectable text. Selectable is nice in the
// full-screen viewers, but in a chat row it makes iOS pop its own text-copy menu
// on long-press, fighting the custom message action menu — so the chat row turns
// it off. Defaults to true to preserve the standalone/viewer behavior.
export const CodeSelectableContext = createContext(true)

// How many lines the inline preview shows before clipping to the expand action.
const PREVIEW_LINES = 16

// ---------------------------------------------------------------------------
// CopyButton — copies `code` to the clipboard, flips to a "Copied" state for 2s.
// ---------------------------------------------------------------------------
function CopyButton({ code }: { code: string }) {
  const { colors } = useTheme()
  const [copied, setCopied] = useState(false)
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current)
      }
    }
  }, [])

  async function handlePress() {
    await Clipboard.setStringAsync(code)
    setCopied(true)
    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current)
    }
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

// ---------------------------------------------------------------------------
// CodeBlock — compact inline preview that opens a full-screen CodeViewer.
//
// Inline, the code is clipped to PREVIEW_LINES lines, each rendered as its own
// <Text numberOfLines={1}> so long lines truncate with an ellipsis. There is no
// horizontal ScrollView here on purpose: a horizontal ScrollView fills its
// cross-axis (vertical) space and balloons inside the chat's inverted FlatList.
// Real reading/scrolling/copying happens in the modal, which is free of that
// constraint. The expand control + line count live in the header next to Copy.
// ---------------------------------------------------------------------------
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const { colors, tokenColors } = useTheme()
  const styles = useMemo(() => makeCodeStyles(colors), [colors])
  const [expanded, setExpanded] = useState(false)

  // Resolve the language: honor the fence, else infer (e.g. shell from a shebang).
  const resolvedLang = useMemo(() => inferLanguage(code, language), [code, language])
  const lang = resolvedLang?.toLowerCase() ?? ''
  const dotColor = LANG_COLORS[lang] ?? colors.textDim
  const displayLang = resolvedLang ?? 'plaintext'

  const codeBg = useMemo(() => codeBgColor(dotColor), [dotColor])
  const selectable = useContext(CodeSelectableContext)
  const lines = useMemo(
    () => highlightCodeLines(code, resolvedLang, colors, tokenColors),
    [code, resolvedLang, colors, tokenColors],
  )
  const totalLines = lines.length
  const isTruncated = totalLines > PREVIEW_LINES
  const previewLines = isTruncated ? lines.slice(0, PREVIEW_LINES) : lines

  return (
    <View style={styles.block}>
      <View style={styles.header}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={styles.lang}>{displayLang}</Text>
        <Pressable
          onPress={() => setExpanded(true)}
          style={styles.expandBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Expand code, ${totalLines} line${totalLines === 1 ? '' : 's'}`}
        >
          <Feather name="maximize-2" size={13} color={colors.textMuted} />
          <Text style={styles.expandLabel}>{totalLines}</Text>
        </Pressable>
        <CopyButton code={code} />
      </View>
      <View style={styles.divider} />
      <View style={[styles.codeContainer, { backgroundColor: codeBg }]}>
        {previewLines.map((line, i) => (
          <Text key={i} style={styles.code} numberOfLines={1} selectable={selectable}>
            {line.length ? line : ' '}
          </Text>
        ))}
        {isTruncated && (
          <Pressable onPress={() => setExpanded(true)} hitSlop={6} style={styles.moreRow}>
            <Text style={styles.moreText}>… {totalLines - PREVIEW_LINES} more lines</Text>
          </Pressable>
        )}
      </View>
      {expanded && (
        <CodeViewer code={code} language={displayLang} lines={lines} onClose={() => setExpanded(false)} />
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// CodeViewer — full-screen modal for a single code block. Scrolls both axes
// (vertical for lines, horizontal for long lines). Being a Modal it renders
// above everything and is not inside the inverted FlatList, so a horizontal
// ScrollView here is safe.
// ---------------------------------------------------------------------------
function CodeViewer({
  code,
  language,
  lines,
  onClose,
}: {
  code: string
  language: string
  lines: ReactNode[][]
  onClose: () => void
}) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const styles = useMemo(() => makeViewerStyles(colors), [colors])

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>{language}</Text>
          <CopyButton code={code} />
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
            {/* Line-number gutter — outside the horizontal ScrollView so it stays
                pinned while the code scrolls sideways, but inside the vertical
                ScrollView so it scrolls up/down with the code. */}
            <View style={styles.gutter}>
              {lines.map((_, i) => (
                <Text key={i} style={styles.gutterText} selectable={false}>{i + 1}</Text>
              ))}
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator style={styles.hScroll}>
              <View style={styles.codeLines}>
                {lines.map((line, i) => (
                  <Text key={i} style={styles.codeLine} selectable>
                    {line.length ? line : ' '}
                  </Text>
                ))}
              </View>
            </ScrollView>
          </View>
        </ScrollView>
      </View>
    </Modal>
  )
}

function makeCodeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    block: {
      backgroundColor: colors.surface,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.borderCode,
      overflow: 'hidden',
      marginVertical: 4,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: colors.bg,
      gap: 8,
    },
    dot: { width: 10, height: 10, borderRadius: 5 },
    lang: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
      fontFamily: typography.fontMono,
      flex: 1,
    },
    expandBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    expandLabel: {
      color: colors.textMuted,
      fontSize: typography.sizeXs,
      fontFamily: typography.fontMono,
    },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderCode },
    codeContainer: { paddingHorizontal: 14, paddingVertical: 14, width: '100%' },
    code: {
      fontFamily: typography.fontMono,
      fontSize: typography.sizeMd,
      lineHeight: typography.lineHeightCode,
      color: colors.text,
    },
    moreRow: { paddingTop: 6 },
    moreText: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
      fontFamily: typography.fontMono,
    },
  })
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
    // Same lineHeight as codeLine so each number aligns with its code row even
    // though the digits are smaller and muted.
    gutterText: {
      fontFamily: typography.fontMono,
      fontSize: typography.sizeSm,
      lineHeight: typography.lineHeightCode,
      color: colors.textDim,
    },
    hScroll: { flex: 1 },
    codeLines: { paddingLeft: 12, paddingRight: spacing.lg },
    codeLine: {
      fontFamily: typography.fontMono,
      fontSize: typography.sizeMd,
      lineHeight: typography.lineHeightCode,
      color: colors.text,
    },
  })
}
