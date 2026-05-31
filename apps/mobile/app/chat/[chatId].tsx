/**
 * Per-agent chat screen with inverted FlatList (WhatsApp model).
 *
 * **Responsibilities split across:**
 *  - useChatSession   — items (chronological), agent status, commands (WS + DB)
 *  - useChatActions   — sendMessage, respond, addSystemMessage
 *  - useChatAnimations — keyboard offset
 *  - MessageList      — inverted rendering (newest at visual bottom)
 *
 * **Architecture:**
 *  - Items stored chronologically (oldest first → newest last)
 *  - Render metadata (groupStartIds, newestId) computed once per items change
 *  - renderItem uses id-based lookups (not array indices)
 *  - MessageList reverses items for display; inverted prop handles the rest
 *
 * **Scroll behavior:**
 *  - Chat opens at visual bottom (newest message) — free from inverted semantics
 *  - User scrolls up → reads history, pagination loads older messages
 *  - New messages arrive → appear at bottom, user not yanked (inverted's free behavior)
 *  - User sends → explicit scrollToBottom() animates to newest
 *  - No scroll position save/restore (acceptable UX trade-off)
 *
 * See docs/chat-scroll-architecture.md for full design rationale.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDB } from '../../db/DBProvider'
import { agentDisplayName } from '../../db/database'
import { useWS } from '../../context/WebSocketContext'
import { useTheme } from '../../context/ThemeContext'
import type { Item } from '../../hooks/chatTypes'
import { useChatSession } from '../../hooks/useChatSession'
import { useChatActions, LOCAL_COMMANDS } from '../../hooks/useChatActions'
import { useKeyboardOffset } from '../../hooks/useChatAnimations'
import { ChatHeader } from '../../components/headers/ChatHeader'
import { Composer } from '../../components/chat/Composer'
import { MessageList } from '../../components/chat/MessageList'
import type { MessageListHandle } from '../../components/chat/MessageList'
import { CommandPicker } from '../../components/chat/CommandPicker'
import { Row } from '../../components/chat/MessageRow'
import { ToolSheet } from '../../components/chat/ToolSheet'

export default function ChatScreen() {
  const { chatId } = useLocalSearchParams<{ chatId?: string | string[] }>()
  const resolvedChatId = useMemo(() => {
    if (Array.isArray(chatId)) return chatId[0] ?? undefined
    return chatId?.trim() ? chatId : undefined
  }, [chatId])
  const db = useDB()
  const { conn, sendEvent, subscribe, setActiveChatId } = useWS()

  useEffect(() => {
    setActiveChatId(resolvedChatId ?? null)
    return () => setActiveChatId(null)
  }, [resolvedChatId, setActiveChatId])
  const { colors } = useTheme()

  const { bottom: safeBottom } = useSafeAreaInsets()
  const [draft, setDraft] = useState('')
  const [isToolSheetOpen, setIsToolSheetOpen] = useState<Item[] | null>(null)
  const messageListRef = useRef<MessageListHandle | null>(null)

  const {
    items,
    setItems,
    agentStatus,
    commands,
    hasMoreOlder,
    loadOlder,
  } = useChatSession(resolvedChatId, db, conn, subscribe, sendEvent)

  const { sendMessage, respond } = useChatActions({ chatId: resolvedChatId, db, conn, sendEvent, items, setItems })
  const kbOffset = useKeyboardOffset(safeBottom)

  const toolsByAgentMsgId = useMemo(() => {
    const map = new Map<string, Item[]>()
    let lastAgentMsgId: string | null = null
    for (const it of items) {
      if (it.kind === 'message' && it.role === 'assistant') {
        lastAgentMsgId = it.id
      } else if (it.kind === 'tool' && lastAgentMsgId) {
        const arr = map.get(lastAgentMsgId) ?? []
        arr.push(it)
        map.set(lastAgentMsgId, arr)
      }
    }
    return map
  }, [items])

  // Filter tools (rendered via badge) and ghost agent messages (done, no text, no tool badge).
  // Ghost messages arise when message_end arrives with no preceding text_delta; they produce
  // an empty wrapper + divider with no visible content, causing blank divider stacking.
  const displayItems = useMemo(() => items.filter((it) => {
    if (it.kind === 'tool') return false
    if (it.kind === 'message' && it.role !== 'user' && it.done && !it.text.trim()) {
      return (toolsByAgentMsgId.get(it.id)?.length ?? 0) > 0
    }
    return true
  }), [items, toolsByAgentMsgId])

  const hasPendingPrompt = useMemo(
    () => displayItems.some((it) => it.kind === 'prompt' && !it.resolved),
    [displayItems],
  )

  // Compute which items start a new message group (avatar visible, metadata shown).
  //
  // Why precompute over chronological items + id-based lookup?
  //   - MessageList reverses items for inverted rendering (data[0] = newest)
  //   - renderItem's `index` is now meaningless (data[5] is the 5th newest, not 5th chronologically)
  //   - Computing "group start" from index would fail (prev item in reversed order ≠ prev in time)
  //
  // Solution: Compute once over chronological items, store IDs in a Set.
  // renderItem does O(1) lookup: `isGroupStart = groupStartIds.has(item.id)`.
  // Result: same semantics ("first in a same-sender run") regardless of render order.
  const groupStartIds = useMemo(() => {
    const set = new Set<string>()
    let prev: Item | undefined
    for (const item of displayItems) {
      if (computeIsGroupStart(item, prev)) set.add(item.id)
      prev = item
    }
    return set
  }, [displayItems])

  // Divider style per item ID, keyed by the item's bottom border.
  // 'heavy' on role transitions (user↔agent) for clear visual separation.
  // 'light' between same-sender messages for subtle readability breaks.
  // 'none' on the chronologically newest item (no border needed at visual bottom).
  const dividerMap = useMemo(() => {
    const map = new Map<string, 'light' | 'heavy' | 'none'>()
    for (let i = 0; i < displayItems.length; i++) {
      const cur = displayItems[i]
      const next = displayItems[i + 1]
      if (!next) {
        map.set(cur.id, 'none')
        continue
      }
      const curRole = cur.kind === 'message' || cur.kind === 'file' ? cur.role : 'other'
      const nextRole = next.kind === 'message' || next.kind === 'file' ? next.role : 'other'
      map.set(cur.id, curRole !== nextRole ? 'heavy' : 'light')
    }
    return map
  }, [displayItems])

  const allCommands = useMemo(() => [...LOCAL_COMMANDS, ...commands], [commands])

  const trimmedDraft = useMemo(() => draft.trim(), [draft])
  const rawQuery = trimmedDraft.startsWith('/') ? trimmedDraft.slice(1) : null
  const pickerQuery = rawQuery !== null && !rawQuery.includes(' ') ? rawQuery.toLowerCase() : null

  const pickerItems = useMemo(() => {
    if (pickerQuery === null) return []
    return allCommands
      .filter((c) =>
        c.name.toLowerCase().startsWith(pickerQuery) ||
        (c.aliases ?? []).some((a) => a.toLowerCase().startsWith(pickerQuery)),
      )
      .slice(0, 20)
  }, [pickerQuery, allCommands])

  const displayName = resolvedChatId ? agentDisplayName(resolvedChatId) : 'Chat'
  const avatarLabel = useMemo(() => getAvatarLabel(displayName), [displayName])
  const canSend = trimmedDraft.length > 0 && conn === 'connected' && (!hasPendingPrompt || trimmedDraft.startsWith('/'))

  const handleSend = useCallback(() => {
    const text = trimmedDraft
    if (!text) return
    sendMessage(text)
    setDraft('')
    // Explicit scroll to bottom on Send. In inverted FlatList, offset: 0 = visual bottom.
    // We animate to ensure the user sees their message land and the agent's streaming reply.
    // (Unlike most interactions, Send is an explicit "I want to be at the bottom" signal.)
    messageListRef.current?.scrollToBottom()
  }, [trimmedDraft, sendMessage])

  const handleCommandSelect = useCallback((name: string) => {
    setDraft(`/${name} `)
  }, [])

  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      const isGroupStart = groupStartIds.has(item.id)
      const dividerKind = dividerMap.get(item.id) ?? 'none'
      const tools =
        item.kind === 'message' && item.role === 'assistant'
          ? toolsByAgentMsgId.get(item.id) ?? []
          : []
      return (
        <Row
          item={item}
          onChoose={respond}
          isGroupStart={isGroupStart}
          dividerKind={dividerKind}
          tools={tools}
          avatarLabel={avatarLabel}
          onOpenTools={setIsToolSheetOpen}
        />
      )
    },
    [groupStartIds, dividerMap, toolsByAgentMsgId, respond, avatarLabel],
  )

  return (
    <Animated.View style={{ flex: 1, backgroundColor: colors.bg, paddingBottom: kbOffset }}>
      <ChatHeader
        displayName={displayName}
        agentStatus={agentStatus}
        connStatus={conn}
      />
      <MessageList
        ref={messageListRef}
        items={displayItems}
        renderItem={renderItem}
        hasMoreOlder={hasMoreOlder}
        onLoadOlder={loadOlder}
      />
      {pickerItems.length > 0 && <CommandPicker items={pickerItems} onSelect={handleCommandSelect} />}
      <Composer draft={draft} setDraft={setDraft} onSend={handleSend} canSend={canSend} blocked={hasPendingPrompt} />
      <ToolSheet
        tools={isToolSheetOpen ?? []}
        visible={isToolSheetOpen !== null}
        onClose={() => setIsToolSheetOpen(null)}
      />
    </Animated.View>
  )
}

function getAvatarLabel(displayName: string): string {
  const trimmed = displayName.trim()
  if (!trimmed) return 'AI'
  const words = trimmed.split(/\s+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return trimmed.slice(0, 2).toUpperCase()
}

/**
 * A message is the start of a new group when the sender, kind, or turn changes.
 */
function computeIsGroupStart(item: Item, prev: Item | undefined): boolean {
  if (!prev) return true
  if (item.kind !== 'message') return true
  if (prev.kind !== 'message') return true
  if (item.role !== prev.role) return true
  if (item.turnId && prev.turnId && item.turnId === prev.turnId) return false
  return true
}
