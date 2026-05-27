/**
 * Windowed message list.
 *  - Edge triggers: fetch older when within 15% of top, newer within 15% of bottom
 *  - Position tracking: per-item onLayout into a Map; topmost viewable item +
 *    sub-item pixel offset reported on a throttled cadence
 *  - One-shot restore: scrolls to the saved item then refines the offset once
 *    that item's layout is measured
 *  - maintainVisibleContentPosition keeps the visible content stable when older
 *    rows are prepended
 *
 * Auto-scroll-to-end behavior has been removed entirely. The component never
 * moves the user; new messages appear below the viewport silently.
 */
import { Component, useCallback, useMemo, useRef } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import type {
  ListRenderItem,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ViewToken,
} from 'react-native'
import type { ReactNode } from 'react'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import type { SavedPosition } from '../../hooks/useChatSession'

type Props = {
  items: Item[]
  renderItem: ListRenderItem<Item>
  initialPosition: SavedPosition | null
  hasMoreOlder: boolean
  hasMoreNewer: boolean
  onLoadOlder: () => void
  onLoadNewer: () => void
  onPositionChange: (pos: SavedPosition) => void
}

const EDGE_FRACTION = 0.15
const POSITION_SAVE_INTERVAL_MS = 500

export function MessageList({
  items,
  renderItem,
  initialPosition,
  hasMoreOlder,
  hasMoreNewer,
  onLoadOlder,
  onLoadNewer,
  onPositionChange,
}: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const listRef = useRef<FlatList<Item> | null>(null)

  // Per-item y-position within the FlatList content view, captured via onLayout.
  // Gets re-populated as items move due to prepending (RN fires onLayout on
  // position changes, not just size changes).
  const layoutMapRef = useRef<Map<string, number>>(new Map())

  // The id of the topmost viewable item, updated via onViewableItemsChanged.
  const topVisibleIdRef = useRef<string | null>(null)

  // One-shot restore guards
  const hasRequestedRestoreRef = useRef(false)
  const hasFinalizedRestoreRef = useRef(false)

  // Throttle position save callback
  const lastPositionSaveRef = useRef(0)

  // Stable refs for FlatList props (avoid the "changing onViewableItemsChanged" warning)
  const viewabilityConfigRef = useRef({ itemVisiblePercentThreshold: 1 })
  const onViewableItemsChangedRef = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0) {
        topVisibleIdRef.current = String(viewableItems[0].item.id)
      }
    },
  )

  // Refine the scroll to itemTopY + savedOffset once the target item has been
  // measured. Idempotent (hasFinalizedRestoreRef guards re-fire). No-op until
  // scrollToIndex has been requested — otherwise an early onLayout for an item
  // that happens to be in the initial render window would scroll prematurely
  // and get overridden by the subsequent scrollToIndex.
  const finalizeRestoreIfReady = useCallback(() => {
    if (!hasRequestedRestoreRef.current) return
    if (hasFinalizedRestoreRef.current) return
    if (!initialPosition) return
    const y = layoutMapRef.current.get(initialPosition.topItemId)
    if (y == null) return
    hasFinalizedRestoreRef.current = true
    listRef.current?.scrollToOffset({
      offset: y + initialPosition.offset,
      animated: false,
    })
  }, [initialPosition])

  // Try to restore once we have items and a saved position. Called from
  // onContentSizeChange so we know the list has at least one layout pass.
  const tryRequestRestore = useCallback(() => {
    if (hasRequestedRestoreRef.current) return
    if (!initialPosition) return
    if (items.length === 0) return
    const idx = items.findIndex((it) => it.id === initialPosition.topItemId)
    if (idx < 0) return
    hasRequestedRestoreRef.current = true
    listRef.current?.scrollToIndex({ index: idx, animated: false, viewPosition: 0 })
    // Target item may already be measured — attempt finalize on the next frame.
    requestAnimationFrame(finalizeRestoreIfReady)
  }, [initialPosition, items, finalizeRestoreIfReady])

  // Wrap renderItem to capture each item's y in the layoutMap. Also attempt to
  // finalize the restore offset (no-op unless scrollToIndex has been requested
  // and we haven't already finalized).
  const wrappedRenderItem = useCallback(
    (info: ListRenderItemInfo<Item>) => (
      <View
        onLayout={(e) => {
          layoutMapRef.current.set(info.item.id, e.nativeEvent.layout.y)
          if (initialPosition && info.item.id === initialPosition.topItemId) {
            finalizeRestoreIfReady()
          }
        }}
      >
        {renderItem(info)}
      </View>
    ),
    [renderItem, initialPosition, finalizeRestoreIfReady],
  )

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent

      // Edge triggers (only meaningful when there's something to scroll into)
      if (contentSize.height > layoutMeasurement.height) {
        const topFrac = contentOffset.y / contentSize.height
        const bottomFrac =
          (contentOffset.y + layoutMeasurement.height) / contentSize.height
        if (topFrac <= EDGE_FRACTION && hasMoreOlder) onLoadOlder()
        if (bottomFrac >= 1 - EDGE_FRACTION && hasMoreNewer) onLoadNewer()
      }

      // Throttled position report — only meaningful after restore is done so we
      // don't overwrite the saved position with the restoring scroll.
      if (!hasRequestedRestoreRef.current && initialPosition) return
      const now = Date.now()
      if (now - lastPositionSaveRef.current < POSITION_SAVE_INTERVAL_MS) return
      lastPositionSaveRef.current = now
      const topId = topVisibleIdRef.current
      if (!topId) return
      const itemY = layoutMapRef.current.get(topId)
      if (itemY == null) return
      onPositionChange({ topItemId: topId, offset: contentOffset.y - itemY })
    },
    [hasMoreOlder, hasMoreNewer, onLoadOlder, onLoadNewer, onPositionChange, initialPosition],
  )

  if (items.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.empty}>No messages yet</Text>
      </View>
    )
  }

  return (
    <MessageListErrorBoundary colors={colors}>
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(it) => `${it.kind}-${it.id}`}
        renderItem={wrappedRenderItem}
        contentContainerStyle={styles.list}
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={tryRequestRestore}
        onViewableItemsChanged={onViewableItemsChangedRef.current}
        viewabilityConfig={viewabilityConfigRef.current}
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({
            offset: info.index * (info.averageItemLength ?? 80),
            animated: false,
          })
        }}
      />
    </MessageListErrorBoundary>
  )
}

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
    emptyWrap: { flex: 1, justifyContent: 'center' },
    empty: { color: colors.textDim, textAlign: 'center', fontSize: typography.sizeLg },
    list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  })
}
