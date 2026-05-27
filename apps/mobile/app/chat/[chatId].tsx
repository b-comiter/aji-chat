/**
 * Per-agent chat screen.
 *
 * Responsible only for rendering. All state management lives in:
 *  - useChatSession  — items, agent status, commands (WS + DB)
 *  - useChatActions  — sendMessage, respond, addSystemMessage
 *  - useChatAnimations — keyboard offset, status pulse
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDB } from '../../db/DBProvider'
import { agentDisplayName, setSetting } from '../../db/database'
import { useWS } from '../../context/WebSocketContext'
import { useTheme } from '../../context/ThemeContext'
import type { Item } from '../../hooks/chatTypes'
import { useChatSession } from '../../hooks/useChatSession'
import type { SavedPosition } from '../../hooks/useChatSession'
import { useChatActions, LOCAL_COMMANDS } from '../../hooks/useChatActions'
import { useKeyboardOffset, usePulseAnimation } from '../../hooks/useChatAnimations'
import { ChatHeader } from '../../components/headers/ChatHeader'
import { Composer } from '../../components/chat/Composer'
import { MessageList } from '../../components/chat/MessageList'
import { CommandPicker } from '../../components/chat/CommandPicker'
import { Row } from '../../components/chat/MessageRow'

export default function ChatScreen() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>()
  const db = useDB()
  const { conn, sendEvent, subscribe } = useWS()
  const { colors } = useTheme()

  const { bottom: safeBottom } = useSafeAreaInsets()
  const [draft, setDraft] = useState('')

  const {
    items,
    setItems,
    agentStatus,
    commands,
    initialPosition,
    hasMoreOlder,
    hasMoreNewer,
    loadOlder,
    loadNewer,
  } = useChatSession(chatId, db, conn, subscribe)

  // Latest reported scroll position from MessageList (kept in a ref so the
  // unmount cleanup can read the value without restarting the effect on every
  // position update).
  const positionRef = useRef<SavedPosition | null>(null)
  const onPositionChange = useCallback((pos: SavedPosition) => {
    positionRef.current = pos
  }, [])

  // Persist scroll position on chat unmount.
  useEffect(() => {
    if (!chatId) return
    return () => {
      const pos = positionRef.current
      if (pos) {
        setSetting(db, `scroll_pos:${chatId}`, JSON.stringify(pos)).catch(() => {})
      }
    }
  }, [db, chatId])

  const { sendMessage, respond } = useChatActions({ chatId, db, conn, sendEvent, items, setItems })
  const kbOffset = useKeyboardOffset(safeBottom)
  const pulseScale = usePulseAnimation(agentStatus)

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

  const displayItems = useMemo(() => items.filter((it) => it.kind !== 'tool'), [items])

  const allCommands = useMemo(() => [...LOCAL_COMMANDS, ...commands], [commands])

  const rawQuery = draft.startsWith('/') ? draft.slice(1) : null
  const pickerQuery = rawQuery !== null && !rawQuery.includes(' ') ? rawQuery.toLowerCase() : null

  const pickerItems = useMemo(() => {
    if (pickerQuery === null) return []
    return allCommands
      .filter((c) =>
        c.name.startsWith(pickerQuery) ||
        (c.aliases ?? []).some((a) => a.startsWith(pickerQuery)),
      )
      .slice(0, 20)
  }, [pickerQuery, allCommands])

  const displayName = chatId ? agentDisplayName(chatId) : 'Chat'
  const avatarLabel = useMemo(() => getAvatarLabel(displayName), [displayName])
  const canSend = draft.trim().length > 0 && conn === 'connected'

  const handleSend = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    sendMessage(text)
    setDraft('')
  }, [draft, sendMessage])

  const renderItem = useCallback(
    ({ item, index }: { item: Item; index: number }) => {
      const prev = displayItems[index - 1]
      const isGroupStart = computeIsGroupStart(item, prev)
      const isLast = index === displayItems.length - 1
      const tools =
        item.kind === 'message' && item.role === 'assistant'
          ? toolsByAgentMsgId.get(item.id) ?? []
          : []
      return (
        <Row
          item={item}
          onChoose={respond}
          isGroupStart={isGroupStart}
          isLast={isLast}
          tools={tools}
          avatarLabel={avatarLabel}
        />
      )
    },
    [displayItems, toolsByAgentMsgId, respond, avatarLabel],
  )

  return (
    <Animated.View style={{ flex: 1, backgroundColor: colors.bg, paddingBottom: kbOffset }}>
      <ChatHeader
        displayName={displayName}
        agentStatus={agentStatus}
        pulseScale={pulseScale}
        connStatus={conn}
      />
      <MessageList
        items={displayItems}
        renderItem={renderItem}
        initialPosition={initialPosition}
        hasMoreOlder={hasMoreOlder}
        hasMoreNewer={hasMoreNewer}
        onLoadOlder={loadOlder}
        onLoadNewer={loadNewer}
        onPositionChange={onPositionChange}
      />
      {pickerItems.length > 0 && (
        <CommandPicker items={pickerItems} onSelect={(name) => setDraft(`/${name} `)} />
      )}
      <Composer draft={draft} setDraft={setDraft} onSend={handleSend} canSend={canSend} />
    </Animated.View>
  )
}

function getAvatarLabel(displayName: string): string {
  const words = displayName.trim().split(/\s+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return displayName.slice(0, 2).toUpperCase()
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
