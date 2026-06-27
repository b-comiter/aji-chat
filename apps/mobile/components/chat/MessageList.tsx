/**
 * Inverted FlatList for chat (WhatsApp/iMessage model).
 *
 * **Design pattern:**
 *   - Items stored chronologically upstream; reversed only at FlatList boundary
 *   - `inverted` prop: data[0] renders at visual bottom (newest), data[N-1] at top (oldest)
 *   - New messages naturally appear at the visual bottom anchor — no sticky-bottom logic
 *   - Streaming text fills in without auto-scroll — the visual anchor stays put
 *
 * **Behavior:**
 *   - Chat opens at bottom (offset: 0)
 *   - User scrolls up → reads history (oldest messages preloaded via loadOlder)
 *   - New messages arrive → appear at bottom (user not yanked if scrolled up)
 *   - User sends message → explicit `scrollToBottom()` animates to newest
 *
 * **Pagination:**
 *   - onScroll detects when user is near visual top (high underlying offset)
 *   - Triggers onLoadOlder to fetch older messages from SQLite
 *   - Window capped at 200 items; oldest drop off when new batches load
 *
 * **What we intentionally omitted:**
 *   - Scroll position save/restore (users always start at bottom; acceptable UX)
 *   - Sticky-bottom auto-scroll on new messages (inverted handles it for free)
 *   - getItemLayout / heightMap tracking (not needed for 200-item window)
 *   - maintainVisibleContentPosition (caused flicker in inverted; trade-off accepted)
 *
 * See docs/chat-scroll-architecture.md for design rationale and alternatives.
 */
import { Component, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import type {
  ListRenderItem,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native'
import type { ReactNode } from 'react'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import { TypingIndicator } from './TypingIndicator'

type Props = {
  items: Item[]
  renderItem: ListRenderItem<Item>
  hasMoreOlder: boolean
  onLoadOlder: () => void
  /** When set, shows an animated typing indicator at the visual bottom of the list. */
  typingStatus?: 'thinking' | 'working'
  avatarLabel?: string
  serverName?: string
}

export type MessageListHandle = {
  scrollToBottom: () => void
}

// Fraction of contentSize from the visual top that triggers loadOlder.
const TOP_EDGE_FRACTION = 0.15
// Pixels scrolled above the visual bottom before the scroll-to-bottom FAB appears.
const SCROLL_UP_THRESHOLD = 120

export const MessageList = forwardRef<MessageListHandle, Props>(function MessageList({
  items,
  renderItem,
  hasMoreOlder,
  onLoadOlder,
  typingStatus,
  avatarLabel,
  serverName,
}, ref) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const listRef = useRef<FlatList<Item> | null>(null)
  const [scrolledUp, setScrolledUp] = useState(false)
  const scrolledUpRef = useRef(false)
  // Count of new messages that arrived while the user was scrolled up; shown on
  // the scroll-to-bottom FAB and cleared once they return to the bottom.
  const [newCount, setNewCount] = useState(0)
  const newestIdRef = useRef<string | null>(null)

  // Bump the count when a genuinely new item appends at the bottom (newest id
  // changes) while scrolled up. Streaming deltas reuse the same id (no bump);
  // pagination prepends older items (newest id unchanged, no bump).
  useEffect(() => {
    const newest = items.length ? items[items.length - 1].id : null
    if (newestIdRef.current !== null && newest !== newestIdRef.current && scrolledUpRef.current) {
      setNewCount((c) => c + 1)
    }
    newestIdRef.current = newest
  }, [items])

  const jumpToBottom = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true })
    setNewCount(0)
  }, [])

  // FlatList wants newest at data[0] for inverted rendering. Upstream (useChatSession)
  // keeps items in chronological order for easier DB queries and state management.
  // We reverse only at this FlatList boundary — the single place the model meets the view.
  // This decouples chronological storage from newest-at-bottom display.
  const reversedItems = useMemo(() => items.slice().reverse(), [items])

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: () => {
        // In inverted, visual bottom = offset 0.
        listRef.current?.scrollToOffset({ offset: 0, animated: true })
      },
    }),
    [],
  )

  // Pagination trigger: when user scrolls to visual top, load older messages.
  //
  // In inverted coordinates:
  //   - contentOffset.y = 0    → visual bottom (newest message, viewport low in content space)
  //   - contentOffset.y = high → visual top   (oldest message, viewport high in content space)
  //
  // topEdgeFrac = position of the visual-top edge of the viewport as a fraction of total
  // content height: (contentOffset.y + viewportHeight) / contentHeight.
  // When the user is at the visual top this approaches 1.0.
  // TOP_EDGE_FRACTION = 0.15 means: fire when top edge enters the top 15% of content.
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
      const offset = contentOffset.y

      // FAB: only setState when crossing the threshold to avoid re-renders on every frame.
      const isUp = offset > SCROLL_UP_THRESHOLD
      if (isUp !== scrolledUpRef.current) {
        scrolledUpRef.current = isUp
        setScrolledUp(isUp)
        if (!isUp) setNewCount(0) // back at the bottom — caught up
      }

      // Pagination: load older messages when user scrolls near the visual top.
      if (!hasMoreOlder || contentSize.height <= layoutMeasurement.height) return
      const topEdgeFrac = (offset + layoutMeasurement.height) / contentSize.height
      if (topEdgeFrac >= 1 - TOP_EDGE_FRACTION) onLoadOlder()
    },
    [hasMoreOlder, onLoadOlder],
  )

  // Show the plain empty state only when there are no messages AND the agent
  // is idle. If the agent is active (typing indicator to show), render the
  // FlatList even with zero data so ListHeaderComponent (the indicator) can mount.
  if (items.length === 0 && !typingStatus) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.empty}>No messages yet</Text>
      </View>
    )
  }

  return (
    <MessageListErrorBoundary colors={colors}>
      <View style={styles.container}>
        <FlatList
          ref={listRef}
          data={reversedItems}
          inverted
          keyExtractor={(it) => `${it.kind}-${it.id}`}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          onScroll={onScroll}
          scrollEventThrottle={64}
          keyboardDismissMode="on-drag"
          ListHeaderComponent={
            typingStatus ? (
              <TypingIndicator
                agentStatus={typingStatus}
                avatarLabel={avatarLabel ?? '?'}
                serverName={serverName}
              />
            ) : null
          }
        />
        {scrolledUp && (
          <Pressable
            style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
            onPress={jumpToBottom}
            accessibilityRole="button"
            accessibilityLabel={newCount > 0 ? `${newCount} new message${newCount === 1 ? '' : 's'}, scroll to bottom` : 'Scroll to bottom'}
          >
            <Text style={styles.fabText}>↓</Text>
            {newCount > 0 && (
              <View style={styles.fabBadge}>
                <Text style={styles.fabBadgeText} numberOfLines={1}>{newCount > 99 ? '99+' : newCount}</Text>
              </View>
            )}
          </Pressable>
        )}
      </View>
    </MessageListErrorBoundary>
  )
})

class MessageListErrorBoundary extends Component<
  { children: ReactNode; colors: ThemeColors },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError(_: unknown) { return { hasError: true } }
  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <Text style={{ color: this.props.colors.danger, textAlign: 'center' }}>
            Something went wrong rendering messages. Navigate away and back to recover.
          </Text>
        </View>
      )
    }
    return this.props.children
  }
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1 },
    emptyWrap: { flex: 1, justifyContent: 'center' },
    empty: { color: colors.textDim, textAlign: 'center', fontSize: typography.sizeLg },
    list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
    fab: {
      position: 'absolute',
      bottom: spacing.lg,
      right: spacing.lg,
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.surface2,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.12,
      shadowRadius: 4,
      elevation: 4,
    },
    fabPressed: { opacity: 0.65 },
    fabText: { color: colors.text, fontSize: 18, lineHeight: 22 },
    fabBadge: {
      position: 'absolute',
      top: -4,
      right: -4,
      minWidth: 18,
      height: 18,
      borderRadius: 9,
      paddingHorizontal: 4,
      backgroundColor: colors.accent,
      borderWidth: 2,
      borderColor: colors.bg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fabBadgeText: {
      color: colors.textOnAccent,
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
    },
  })
}
