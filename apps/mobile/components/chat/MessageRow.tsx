import { memo, useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { MarkdownMessage } from '../MarkdownMessage'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import { Avatar } from './Avatar'
import { PromptRow } from './PromptRow'

// Regex matching common streaming cursor glyphs and simple ANSI show/hide sequences
const STREAM_CURSOR_RE = /\s*(?:▉|▍|█|▌|\||_|\x1b\[\?25[lh])\s*$/

function stripStreamingCursor(text: string): string {
  return text.replace(STREAM_CURSOR_RE, '')
}

type Props = {
  item: Item
  onChoose: (id: string, choice: string) => void
  isGroupStart: boolean
  isLast: boolean
  tools: Item[]
  avatarLabel: string
}

export const Row = memo(function Row({ item, onChoose, isGroupStart, isLast, tools, avatarLabel }: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  if (item.kind === 'message') {
    const isUser = item.role === 'user'
    const displayText = isUser ? item.text : stripStreamingCursor(item.text)
    const hasTools = tools.length > 0
    const showBubble = isUser || hasTools

    return (
      <View style={[styles.msgWrapper, !isLast && styles.msgBorder]}>
        {isGroupStart && (
          <View style={[styles.msgMeta, isUser && styles.msgMetaUserRight]}>
            {!isUser && <Avatar label={avatarLabel} variant="agent" />}
          </View>
        )}
        <View style={isUser ? styles.msgAlignRight : styles.msgAlignLeft}>
          <View style={[
            showBubble && styles.bubble,
            isUser ? styles.bubbleUser : showBubble && styles.bubbleAgent,
          ]}>
            {isUser || !item.done ? (
              <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
                {displayText}{!item.done && <Text style={styles.cursor}> ▍</Text>}
              </Text>
            ) : (
              /* 🛠️ FIX APPLIED HERE: Restrict container and allow it to shrink horizontally and vertically */
              <View style={{ borderWidth: 1, borderColor: 'transparent', flexShrink: 1, alignSelf: 'flex-start', width: '100%' }}>
                <MarkdownMessage content={displayText} />
              </View>
            )}
            {!isUser && hasTools && (
              <Pressable onPress={() => {}} style={styles.toolBadge}>
                <Text style={styles.toolBadgeText}>
                  🔧 {tools.length} tool call{tools.length === 1 ? '' : 's'} ›
                </Text>
              </Pressable>
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
    msgBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      paddingBottom: spacing.md,
      marginBottom: spacing.xs,
    },
    msgMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
    msgMetaUserRight: {},
    msgAlignLeft: { alignItems: 'flex-start' },
    msgAlignRight: { alignItems: 'flex-end' },
    bubble: { borderRadius: radius.xl, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
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
