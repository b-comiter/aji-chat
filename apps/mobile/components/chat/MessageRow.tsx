import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { MarkdownMessage } from '../MarkdownMessage'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import { Avatar } from './Avatar'
import { PromptRow } from './PromptRow'
import { AudioMessage } from './AudioMessage'
import { filePreviewLabel, isAudioMime } from './fileHelpers'

// Regex matching common streaming cursor glyphs and simple ANSI show/hide sequences
const STREAM_CURSOR_RE = /\s*(?:▉|▍|█|▌|\||_|\x1b\[\?25[lh])\s*$/

function stripStreamingCursor(text: string): string {
  return text.replace(STREAM_CURSOR_RE, '')
}

type Props = {
  item: Item
  onChoose: (id: string, choice: string) => void
  isGroupStart: boolean
  dividerKind: 'none' | 'light' | 'heavy'
  tools: Item[]
  avatarLabel: string
  onOpenTools: (tools: Item[]) => void
}

export const Row = memo(function Row({ item, onChoose, isGroupStart, dividerKind, tools, avatarLabel, onOpenTools }: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [copied, setCopied] = useState(false)
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current)
      }
    }
  }, [])

  const handleLongPress = useCallback(async () => {
    if (item.kind !== 'message') return
    const text = item.role === 'user' ? item.text : stripStreamingCursor(item.text)
    if (!text) return
    try {
      await Clipboard.setStringAsync(text)
      setCopied(true)
      AccessibilityInfo.announceForAccessibility('Copied')
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current)
      }
      copiedTimeoutRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Ignore clipboard failures so message rendering remains responsive.
    }
  }, [item])

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
              onLongPress={handleLongPress}
              delayLongPress={400}
              accessibilityRole="button"
              accessibilityLabel="Copy message"
              accessibilityHint="Long press to copy this message"
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
              <View style={styles.markdownContainer}>
                <MarkdownMessage content={displayText} />
              </View>
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
          {copied && (
            <View style={[styles.copiedRow, isUser && styles.copiedRowRight]}>
              <View style={styles.copiedPill}>
                <Text style={styles.copiedPillText}>Copied</Text>
              </View>
            </View>
          )}
        </View>

      </View>
    )
  }

  if (item.kind === 'file') {
    const isUser = item.role === 'user'
    return (
      <View style={[styles.msgWrapper, dividerKind === 'light' && styles.msgBorderLight,
      dividerKind === 'heavy' && styles.msgBorderHeavy]}>
        {isGroupStart && (
          <View style={[styles.msgMeta, isUser && styles.msgMetaUserRight]}>
            {!isUser && <Avatar label={avatarLabel} variant="agent" />}
          </View>
        )}
        <View style={isUser ? styles.msgAlignRight : styles.msgAlignLeft}>
          <View style={[styles.bubble, styles.fileBubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
            {isAudioMime(item.mime) ? (
              <AudioMessage item={item} tint={isUser} />
            ) : (
              <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
                {filePreviewLabel(item)}
              </Text>
            )}
          </View>
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
    copiedRow: {
      flexDirection: 'row',
      marginTop: 3,
    },
    copiedRowRight: {
      justifyContent: 'flex-end',
    },
    copiedPill: {
      backgroundColor: colors.surface3,
      borderRadius: radius.full,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    copiedPillText: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
      fontWeight: typography.weightMedium,
    },
  })
}
