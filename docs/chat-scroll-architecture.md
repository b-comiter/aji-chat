# Chat Scroll Architecture

## Overview

The aji-chat mobile app uses an **inverted FlatList** pattern (WhatsApp/iMessage model) for chat scrolling. This document explains the architecture, why we chose it, and how it works.

## Why Inverted FlatList?

### The Problem We Solved

Early iterations attempted to implement scroll-to-bottom + scroll-position restoration in a **non-inverted** FlatList:
- New messages extend the content vertically downward, moving the scroll anchor
- Sticky-bottom auto-scroll required complex state machine logic to distinguish:
  - User scrolled up (don't auto-scroll)
  - User scrolled down (auto-scroll to bottom)
  - Streaming text added (should follow cursor, not jump)
- Scroll position save/restore computed raw offsets, which broke when new messages arrived between sessions
- Rapid scrolling caused layout jitter as messages re-measured and accumulated height corrections

Result: ~670 lines of scroll state machine code with persistent bugs and race conditions (see deleted `scrollStateMachine.ts`).

### The Solution

**Inverted FlatList** (render newest at visual bottom, oldest at visual top):
- New messages naturally appear at the visual bottom anchor — no sticky-bottom logic needed
- Streaming text fills in without auto-scroll logic — the visual bottom just stays put
- Users scrolled up see history without jank — inverted semantics handle it natively

### Trade-offs

- **Gain**: Simpler, fewer bugs, matches user expectations (WhatsApp model)
- **Loss**: When user scrolls up and new messages arrive, content may shift slightly — we do NOT restore their scroll position. This is acceptable because:
  1. Messages are short-lived (most users view recent history)
  2. The user can easily scroll back to where they were
  3. The alternative (complex save/restore) caused more jitter than this

## Architecture

### Inverted FlatList Rendering

**In `MessageList.tsx`:**

```typescript
const reversedItems = useMemo(() => items.slice().reverse(), [items])

<FlatList
  data={reversedItems}      // data[0] = newest, data[N-1] = oldest
  inverted                  // render data[0] at visual bottom
  renderItem={renderItem}
  keyExtractor={(it) => `${it.kind}-${it.id}`}
/>
```

**Why reverse at the boundary:**
- Upstream code (hooks, chat screen) keeps items in chronological order
- This is the single place where we "invert" for display
- Decouples the model (chronological) from the view (newest-at-bottom)

### Scroll Position Tracking

**We do NOT save/restore scroll position.** Instead:

1. **Open a chat** → FlatList naturally lands at `offset: 0` (visual bottom, newest message)
2. **User scrolls up** → can read history, pagination loads older messages
3. **Agent sends text** → new message appears at visual bottom; if user is scrolled up, they don't get yanked (inverted FlatList's free behavior)
4. **User sends message** → explicit `messageListRef.current?.scrollToBottom()` call animates to newest message

### Pagination

**Triggered by onScroll edge check:**

```typescript
const onScroll = useCallback(
  (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!hasMoreOlder) return
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    if (contentSize.height <= layoutMeasurement.height) return
    const bottomFrac = (contentOffset.y + layoutMeasurement.height) / contentSize.height
    if (bottomFrac >= 1 - TOP_EDGE_FRACTION) onLoadOlder()  // TOP_EDGE_FRACTION = 0.15
  },
  [hasMoreOlder, onLoadOlder],
)
```

**In inverted coordinates:**
- `offset: 0` is the visual bottom (newest)
- `offset: high` is the visual top (oldest)
- When user scrolls to visual top, `bottomFrac` approaches `1.0`
- We trigger `onLoadOlder` to paginate older messages from SQLite

**useChatSession** loads items in a **sliding window**:
- Initial load: 100 most recent items (fits in memory)
- Pagination: when user scrolls to visual top, load 100 older items, prepend to window
- Window limit: cap at 200 items total (oldest messages drop off)

### Item Metadata for Rendering

**Group start detection** (which avatar/header to show):

```typescript
// In [chatId].tsx, computed ONCE over chronological items
const groupStartIds = useMemo(() => {
  const set = new Set<string>()
  let prev: Item | undefined
  for (const item of displayItems) {
    if (computeIsGroupStart(item, prev)) set.add(item.id)
    prev = item
  }
  return set
}, [displayItems])

// Passed to renderItem, which does O(1) lookup
const isGroupStart = groupStartIds.has(item.id)
```

**Last message detection** (for bottom border):

```typescript
const newestId = displayItems[displayItems.length - 1]?.id  // chronological order
const isLast = item.id === newestId  // in renderItem
```

**Why id-based instead of index-based:**
- Index is meaningless in inverted rendering (data[0] is newest, but data[N-1] is oldest)
- IDs stay stable across re-renders and reversals
- renderItem doesn't need to know about array position

### Follow Streaming Behavior

**User sees streaming text appear at the visual bottom in real-time** — no special logic required:

1. Agent sends `message_start` + `text_delta` events
2. `useChatSession` appends to items (in-memory)
3. React re-renders, `displayItems` updated
4. FlatList re-measures reversed data
5. New item appears at visual bottom (data[0] = newest)
6. Text fills in character-by-character via `text_delta` events

The inverted anchor (visual bottom = data[0]) handles the rest. No `maintainVisibleContentPosition`, no scroll state machine.

## Files and Responsibilities

| File | Responsibility |
|---|---|
| `MessageList.tsx` | Minimal inverted FlatList shell (~115 lines); exposes `scrollToBottom()` ref |
| `[chatId].tsx` | Computes `groupStartIds` Set + `newestId`; calls `scrollToBottom()` on Send; passes metadata to renderItem |
| `useChatSession.ts` | Manages items in chronological order; pagination via `loadOlder`; persists to SQLite |
| `chatTypes.ts` | Item type definitions; `ensureMessageExists()` helper for out-of-order events |
| `MessageRow.tsx` | Renders individual items; reads `isGroupStart`/`isLast` from props; no scroll logic |

## Test Coverage

**24 pure function tests** across the codebase:
- `packages/protocol/src/index.test.ts` — message ID generation, type narrowing
- `apps/mobile/hooks/chatTypes.test.ts` — `ensureMessageExists()` out-of-order event handling
- `apps/mobile/components/chat/toolSheetHelpers.test.ts` — JSON formatting, tool icon selection

All tests use Jest 29 + jest-expo preset. Run with `pnpm test`.

## Known Limitations and Future Work

### Current Behavior

1. **No scroll position save/restore** — users always start at the bottom when opening a chat. If they scroll up and new messages arrive, they won't be auto-scrolled back. This is acceptable because:
   - Most chats show recent messages
   - Users can scroll back manually
   - The WhatsApp/Telegram UX also behaves this way

2. **No sticky-bottom indicator** — we don't show a "new messages" badge or "scroll to bottom" button when user scrolls up. This could be added later if needed.

### Future Enhancements

- **Scroll-to-bottom button** — when user scrolls up and new messages arrive, show a floating "↓ Scroll to new message" button
- **Read markers** — persist which messages user has seen, dim older ones
- **Search** — find messages by keyword across all chats
- **Message reactions** — add emoji reactions to messages (requires protocol + DB changes)

## Related Decisions

- **Why not `maintainVisibleContentPosition`?** — Causes flicker in inverted lists when new items are prepended (pagination). We accept the trade-off of not restoring scroll position.
- **Why not `getItemLayout`?** — Not needed in inverted (no item height caching required for performance). FlatList's built-in virtualization is sufficient for 200-item window.
- **Why SQLite + in-memory window instead of server pagination?** — Local-first: chats open instantly, work offline, no API latency. Server only stores recent history; SQLite stores everything.

## Debugging

Enable detailed trace logs in `[chatId].tsx`:

```typescript
const TRACE = true  // Set to false for production

if (TRACE) {
  console.log('[Chat]', {
    itemCount: items.length,
    newestId,
    groupStartIds: groupStartIds.size,
    hasMoreOlder,
  })
}
```

Then in your terminal:
```bash
pnpm mobile  # Expo starts
# Scan QR with Expo Go on device
# Open chat and watch `console.log` in terminal
```

## References

- **Code**: `apps/mobile/app/chat/[chatId].tsx`, `apps/mobile/components/chat/MessageList.tsx`
- **Protocol**: `packages/protocol/src/index.ts` (`ServerEvent`, `ClientEvent`)
- **Database**: `apps/mobile/db/database.ts` (`ItemRow`, `loadRecentItems`, `loadOlderThan`)
- **Styling**: `apps/mobile/docs/styling.md` — message bubble design patterns
