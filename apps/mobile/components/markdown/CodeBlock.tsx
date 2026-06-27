import { createContext, useContext, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { useTheme } from '../../context/ThemeContext'
import { LANG_COLORS, codeBgColor } from '../colorUtils'
import { highlightCodeLines, inferLanguage } from './highlight'
import { CodeViewerModal, CopyButton } from './CodeViewerModal'
import type { ViewerRow } from './CodeViewerModal'

// Whether code blocks render selectable text. Selectable is nice in the
// full-screen viewers, but in a chat row it makes iOS pop its own text-copy menu
// on long-press, fighting the custom message action menu — so the chat row turns
// it off. Defaults to true to preserve the standalone/viewer behavior.
export const CodeSelectableContext = createContext(true)

// How many lines the inline preview shows before clipping to the expand action.
const PREVIEW_LINES = 16

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

  // Rows for the full-screen viewer: a 1-based line number + the highlighted line.
  const viewerRows = useMemo<ViewerRow[]>(
    () =>
      lines.map((line, i) => ({
        gutter: String(i + 1),
        content: (
          <Text style={styles.viewerLine} selectable>
            {line.length ? line : ' '}
          </Text>
        ),
      })),
    [lines, styles],
  )

  return (
    <View style={styles.block}>
      <View style={styles.header}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={styles.lang} numberOfLines={1}>{displayLang}</Text>
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
        <CodeViewerModal
          title={displayLang}
          actions={<CopyButton code={code} />}
          rows={viewerRows}
          onClose={() => setExpanded(false)}
        />
      )}
    </View>
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
    // Line body inside the full-screen viewer (CodeViewerModal owns the layout).
    viewerLine: {
      fontFamily: typography.fontMono,
      fontSize: typography.sizeMd,
      lineHeight: typography.lineHeightCode,
      color: colors.text,
    },
  })
}
