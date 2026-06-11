import { memo, useCallback, useMemo, useRef } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { View as RNView } from 'react-native'
import * as Haptics from 'expo-haptics'
import { Feather } from '@expo/vector-icons'
import { MarkdownMessage } from '../MarkdownMessage'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import { stripStreamingCursor } from '../../hooks/chatTypes'
import { Avatar } from './Avatar'
import { PromptRow } from './PromptRow'
import { AudioMessage } from './AudioMessage'
import { ImageMessage } from './ImageMessage'
import { fileViewerKind, fileIconName, approxBytesFromBase64, formatBytes } from './fileHelpers'
import type { Rect } from './MessageActionMenu'

type FileItem = Extract<Item, { kind: 'file' }>

// Haptics no-op on web / on dev clients built before expo-haptics was linked
// (the native call throws/rejects there) — mirrors the guard in DraggableList.
function safeHaptic() {
  try {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {})
  } catch {
    /* haptics unavailable — ignore */
  }
}

function FileChip({
  item,
  styles,
  colors,
  onPress,
}: {
  item: FileItem
  styles: ReturnType<typeof makeStyles>
  colors: ThemeColors
  onPress: (item: FileItem) => void
}) {
  const bytes = approxBytesFromBase64(item.data)
  return (
    <Pressable
      onPress={() => onPress(item)}
      style={styles.fileChip}
      accessibilityRole="button"
      accessibilityLabel={item.name ? `Open file ${item.name}` : 'Open file'}
      accessibilityHint="Opens the file full screen"
    >
      <View style={styles.fileIconBox}>
        <Feather name={fileIconName(item) as any} size={20} color={colors.accent} />
      </View>
      <View style={styles.fileChipMeta}>
        <Text style={styles.fileChipName} numberOfLines={1}>{item.name ?? item.mime}</Text>
        <Text style={styles.fileChipSub} numberOfLines={1}>{item.mime} · {formatBytes(bytes)}</Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.textDim} />
    </Pressable>
  )
}

type Props = {
  item: Item
  onChoose: (id: string, choice: string) => void
  isGroupStart: boolean
  dividerKind: 'none' | 'light' | 'heavy'
  tools: Item[]
  avatarLabel: string
  onOpenTools: (tools: Item[]) => void
  onOpenFile: (item: FileItem) => void
  onLongPressItem?: (item: Item, rect: Rect) => void
}

export const Row = memo(function Row({ item, onChoose, isGroupStart, dividerKind, tools, avatarLabel, onOpenTools, onOpenFile, onLongPressItem }: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  // Ref on the bubble/content so the long-press can measure its on-screen rect
  // and hand it to the centered action-menu overlay (owned by the chat screen).
  const contentRef = useRef<RNView | null>(null)

  const handleLongPress = useCallback(() => {
    if (!onLongPressItem) return
    const node = contentRef.current
    if (!node) return
    safeHaptic()
    node.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) onLongPressItem(item, { x, y, width, height })
    })
  }, [onLongPressItem, item])

  if (item.kind === 'message') {
    const isUser = item.role === 'user'
    const displayText = isUser ? item.text : stripStreamingCursor(item.text)
    const hasTools = tools.length > 0
    const shouldRenderPlainText = isUser || !item.done

    return (
      <View style={[styles.msgWrapper, dividerKind === 'light' && styles.msgBorderLight,
      dividerKind === 'heavy' && styles.msgBorderHeavy]}>
        {isGroupStart && (
          <View style={[styles.msgMeta, isUser && styles.msgMetaUserRight]}>
            {!isUser && <Avatar label={avatarLabel} variant="agent" />}
          </View>
        )}
        <View testID="message-container" style={isUser ? styles.msgAlignRight : styles.msgAlignLeft}>
          {shouldRenderPlainText ? (
            <Pressable
              ref={contentRef}
              onLongPress={handleLongPress}
              delayLongPress={280}
              accessibilityRole="button"
              accessibilityLabel="Message"
              accessibilityHint="Long press for message actions"
            >
              <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
                <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
                  {displayText}{!item.done && <Text style={styles.cursor}> ▍</Text>}
                </Text>
                {!isUser && hasTools && (
                  <Pressable
                    onPress={() => onOpenTools(tools)}
                    style={styles.toolBadge}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${tools.length} tool call${tools.length === 1 ? '' : 's'}`}
                    accessibilityHint="Shows tool calls used for this response"
                  >
                    <Text style={styles.toolBadgeText}>
                      🔧 {tools.length} tool call{tools.length === 1 ? '' : 's'} ›
                    </Text>
                  </Pressable>
                )}
              </View>
            </Pressable>
          ) : (
            <>
              <Pressable
                ref={contentRef}
                onLongPress={handleLongPress}
                delayLongPress={280}
                accessibilityRole="button"
                accessibilityLabel="Message"
                accessibilityHint="Long press for message actions"
              >
                <View style={styles.markdownContainer}>
                  <MarkdownMessage content={displayText} selectable={false} />
                </View>
              </Pressable>
              {hasTools && (
                <Pressable
                  onPress={() => onOpenTools(tools)}
                  style={styles.toolBadge}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${tools.length} tool call${tools.length === 1 ? '' : 's'}`}
                  accessibilityHint="Shows tool calls used for this response"
                >
                  <Text style={styles.toolBadgeText}>
                    🔧 {tools.length} tool call{tools.length === 1 ? '' : 's'} ›
                  </Text>
                </Pressable>
              )}
            </>
          )}
        </View>

      </View>
    )
  }

  if (item.kind === 'file') {
    const isUser = item.role === 'user'
    const kind = fileViewerKind(item)
    return (
      <View style={[styles.msgWrapper, dividerKind === 'light' && styles.msgBorderLight,
      dividerKind === 'heavy' && styles.msgBorderHeavy]}>
        {isGroupStart && (
          <View style={[styles.msgMeta, isUser && styles.msgMetaUserRight]}>
            {!isUser && <Avatar label={avatarLabel} variant="agent" />}
          </View>
        )}
        <View style={isUser ? styles.msgAlignRight : styles.msgAlignLeft}>
          <Pressable ref={contentRef} onLongPress={handleLongPress} delayLongPress={280}>
            {kind === 'image' ? (
              <ImageMessage item={item} tint={isUser} onPress={onOpenFile} />
            ) : kind === 'audio' ? (
              <View style={[styles.bubble, styles.fileBubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
                <AudioMessage item={item} tint={isUser} />
              </View>
            ) : (
              <FileChip item={item} styles={styles} colors={colors} onPress={onOpenFile} />
            )}
          </Pressable>
        </View>
      </View>
    )
  }

  if (item.kind === 'prompt') {
    return <PromptRow item={item} onChoose={onChoose} />
  }

  // Tool items are filtered out at the chat-screen level and surface via the
  // toolBadge on the preceding assistant message instead.
  return null
})

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    msgWrapper: { flexDirection: 'column', paddingVertical: spacing.sm },
    msgBorderLight: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      paddingBottom: spacing.md,
      marginBottom: spacing.xs,
    },
    msgBorderHeavy: {
      borderBottomWidth: 1,
      borderBottomColor: colors.borderAlt,
      paddingBottom: spacing.md,
      marginBottom: spacing.sm,
    },
    msgMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
    msgMetaUserRight: {},
    msgAlignLeft: { alignItems: 'flex-start' },
    msgAlignRight: { alignItems: 'flex-end' },
    bubble: { borderRadius: radius.xl, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    markdownContainer: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.xl,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      alignSelf: 'stretch',
      maxWidth: '100%',
    },
    fileBubble: { maxWidth: '85%' },
    fileChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      maxWidth: 280,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.xl,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    fileIconBox: {
      width: 40,
      height: 40,
      borderRadius: radius.md,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fileChipMeta: { flex: 1, gap: 2 },
    fileChipName: { color: colors.text, fontSize: typography.sizeMd, fontWeight: typography.weightSemibold },
    fileChipSub: { color: colors.textDim, fontSize: typography.sizeSm },
    bubbleAgent: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    bubbleUser: { backgroundColor: colors.accent, maxWidth: '85%' },
    bubbleText: { color: colors.text, fontSize: typography.sizeLg, lineHeight: typography.lineHeightNormal },
    bubbleTextUser: { color: '#fff' },
    cursor: { color: colors.accent },
    toolBadge: {
      backgroundColor: colors.toolDim,
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 4,
      marginTop: spacing.sm,
      alignSelf: 'flex-start',
    },
    toolBadgeText: {
      color: colors.tool,
      fontSize: typography.sizeSm,
      fontWeight: typography.weightSemibold,
    },
  })
}
