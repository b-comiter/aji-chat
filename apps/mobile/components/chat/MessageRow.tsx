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
import { DiffCard } from './DiffCard'
import { parseEditDiff } from './diffHelpers'
import { AudioMessage } from './AudioMessage'
import { ImageMessage } from './ImageMessage'
import { fileViewerKind, fileIconName, approxBytesFromBase64, formatBytes } from './fileHelpers'
import type { FileViewerKind } from './fileHelpers'
import { HtmlThumbnail } from './HtmlThumbnail'
import { MarkdownThumbnail } from './MarkdownThumbnail'
import { formatMessageTime } from './timeHelpers'
import type { Rect } from './MessageActionMenu'

type FileItem = Extract<Item, { kind: 'file' }>

// Chat-bubble corner radius. Larger than radius.xl for a softer, more modern
// bubble; the corner nearest the sender's avatar is squared off (radius.sm) as
// a subtle "tail" so each bubble reads as anchored to its sender.
const BUBBLE_RADIUS = 18

// Tool-call affordance shown beneath an assistant message — opens the tool sheet.
function ToolBadge({
  count,
  styles,
  colors,
  onPress,
}: {
  count: number
  styles: ReturnType<typeof makeStyles>
  colors: ThemeColors
  onPress: () => void
}) {
  const plural = count === 1 ? '' : 's'
  return (
    <Pressable
      onPress={onPress}
      style={styles.toolBadge}
      accessibilityRole="button"
      accessibilityLabel={`Open ${count} tool call${plural}`}
      accessibilityHint="Shows tool calls used for this response"
    >
      <Feather name="tool" size={12} color={colors.tool} />
      <Text style={styles.toolBadgeText}>{count} tool call{plural}</Text>
      <Feather name="chevron-right" size={13} color={colors.tool} />
    </Pressable>
  )
}

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
  kind,
  styles,
  colors,
  onPress,
}: {
  item: FileItem
  kind: FileViewerKind
  styles: ReturnType<typeof makeStyles>
  colors: ThemeColors
  onPress: (item: FileItem) => void
}) {
  const bytes = approxBytesFromBase64(item.data)
  // HTML + Markdown files get a rendered thumbnail above the meta row; everything
  // else keeps the icon-only chip. Each thumbnail self-removes on failure (missing
  // WebView, unreadable bytes), so this layout degrades to the plain chip with no
  // extra handling here.
  const thumbnail =
    kind === 'html' ? <HtmlThumbnail item={item} />
    : kind === 'markdown' ? <MarkdownThumbnail item={item} />
    : null
  const meta = (
    <>
      <View style={styles.fileChipRow}>
        <View style={styles.fileIconBox}>
          <Feather name={fileIconName(item)} size={20} color={colors.accent} />
        </View>
        <View style={styles.fileChipMeta}>
          <Text style={styles.fileChipName} numberOfLines={1}>{item.name ?? item.mime}</Text>
          <Text style={styles.fileChipSub} numberOfLines={1}>{item.mime} · {formatBytes(bytes)}</Text>
        </View>
        <Feather name="chevron-right" size={18} color={colors.textDim} />
      </View>
      {item.text ? <Text style={styles.fileChipCaption}>{item.text}</Text> : null}
    </>
  )
  return (
    <Pressable
      onPress={() => onPress(item)}
      style={[styles.fileChip, thumbnail && styles.fileChipPreview]}
      accessibilityRole="button"
      accessibilityLabel={item.name ? `Open file ${item.name}` : 'Open file'}
      accessibilityHint="Opens the file full screen"
    >
      {thumbnail ? (
        <>
          {thumbnail}
          <View style={styles.fileChipBody}>{meta}</View>
        </>
      ) : (
        meta
      )}
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
  /** Source chat identity — forwarded to AudioMessage for the global mini-player. */
  serverId?: string
  channelId?: string
  /** Display name of the source chat, used as the mini-player title fallback. */
  serverName?: string
}

export const Row = memo(function Row({ item, onChoose, isGroupStart, dividerKind, tools, avatarLabel, onOpenTools, onOpenFile, onLongPressItem, serverId, channelId, serverName }: Props) {
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
          <View style={styles.msgMeta}>
            {!isUser && <Avatar label={avatarLabel} variant="agent" seed={serverName} />}
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
                  <ToolBadge count={tools.length} styles={styles} colors={colors} onPress={() => onOpenTools(tools)} />
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
                <ToolBadge count={tools.length} styles={styles} colors={colors} onPress={() => onOpenTools(tools)} />
              )}
            </>
          )}
          {item.createdAt != null && (
            <Text style={styles.time}>{formatMessageTime(item.createdAt)}</Text>
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
          <View style={styles.msgMeta}>
            {!isUser && <Avatar label={avatarLabel} variant="agent" seed={serverName} />}
          </View>
        )}
        <View style={isUser ? styles.msgAlignRight : styles.msgAlignLeft}>
          <Pressable ref={contentRef} onLongPress={handleLongPress} delayLongPress={280}>
            {kind === 'image' ? (
              <ImageMessage item={item} tint={isUser} onPress={onOpenFile} />
            ) : kind === 'audio' ? (
              <View style={[styles.bubble, styles.fileBubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
                <AudioMessage item={item} tint={isUser} serverId={serverId} channelId={channelId} fallbackTitle={serverName} />
              </View>
            ) : (
              <FileChip item={item} kind={kind} styles={styles} colors={colors} onPress={onOpenFile} />
            )}
          </Pressable>
          {item.createdAt != null && (
            <Text style={styles.time}>{formatMessageTime(item.createdAt)}</Text>
          )}
        </View>
      </View>
    )
  }

  if (item.kind === 'prompt') {
    return <PromptRow item={item} onChoose={onChoose} />
  }

  // File-edit tool calls render inline as a diff card (Option C). All other tool
  // items are filtered out at the chat-screen level and surface via the toolBadge
  // on the preceding assistant message instead.
  if (item.kind === 'tool') {
    const diff = parseEditDiff(item.name, item.args, item.result)
    if (!diff) return null
    return (
      <View style={[styles.msgWrapper, dividerKind === 'light' && styles.msgBorderLight,
      dividerKind === 'heavy' && styles.msgBorderHeavy]}>
        <View style={styles.msgAlignLeft}>
          <DiffCard diff={diff} />
          {item.createdAt != null && (
            <Text style={styles.time}>{formatMessageTime(item.createdAt)}</Text>
          )}
        </View>
      </View>
    )
  }

  return null
})

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    msgWrapper: { flexDirection: 'column', paddingVertical: spacing.sm },
    // Subtle hairline between messages from the same sender (within a group).
    msgBorderLight: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      paddingBottom: spacing.sm,
      marginBottom: spacing.sm,
    },
    // Bold bar at a sender change (user↔agent) — a clear section break: thicker
    // line + more vertical room so the turn boundary reads at a glance.
    msgBorderHeavy: {
      borderBottomWidth: 2,
      borderBottomColor: colors.borderAlt,
      paddingBottom: spacing.lg,
      marginBottom: spacing.lg,
    },
    msgMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
    msgAlignLeft: { alignItems: 'flex-start' },
    msgAlignRight: { alignItems: 'flex-end' },
    bubble: { borderRadius: BUBBLE_RADIUS, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    markdownContainer: {
      backgroundColor: colors.assistantBubbleBg,
      borderWidth: 1,
      borderColor: colors.assistantBubbleBorder,
      borderRadius: BUBBLE_RADIUS,
      // Tail corner nearest the avatar — anchors the bubble to its sender.
      borderTopLeftRadius: radius.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      alignSelf: 'stretch',
      maxWidth: '100%',
    },
    fileBubble: { maxWidth: '85%' },
    fileChip: {
      maxWidth: 280,
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.xl,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      overflow: 'hidden',
    },
    // Preview chip (HTML/Markdown): the thumbnail bleeds to the chip edges
    // (clipped by overflow), so the outer padding moves onto the meta body.
    fileChipPreview: {
      maxWidth: 300,
      gap: 0,
      paddingHorizontal: 0,
      paddingVertical: 0,
    },
    fileChipBody: {
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    fileChipRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    fileChipCaption: {
      color: colors.text,
      fontSize: typography.sizeLg,
      lineHeight: typography.lineHeightNormal,
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
    bubbleAgent: {
      backgroundColor: colors.assistantBubbleBg,
      borderWidth: 1,
      borderColor: colors.assistantBubbleBorder,
      borderTopLeftRadius: radius.sm,
    },
    bubbleUser: { backgroundColor: colors.userBubbleBg, maxWidth: '85%', borderTopRightRadius: radius.sm },
    bubbleText: { color: colors.assistantBubbleText, fontSize: typography.sizeLg, lineHeight: typography.lineHeightNormal },
    bubbleTextUser: { color: colors.userBubbleText },
    // Per-message clock; aligns to the message side via the container's alignItems.
    time: { color: colors.textDim, fontSize: typography.sizeXs, marginTop: 3 },
    cursor: { color: colors.accent },
    toolBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: colors.toolDim,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 5,
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
