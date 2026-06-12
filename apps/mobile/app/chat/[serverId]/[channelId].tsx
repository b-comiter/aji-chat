/**
 * Per-channel chat screen with inverted FlatList (WhatsApp model).
 *
 * Routed as /chat/[serverId]/[channelId] — the leaf of the Server → Channel
 * drill-down. `serverId` is the protocol `agent` (the server); `channelId`
 * scopes the conversation within it.
 *
 * **Responsibilities split across:**
 *  - useChatSession   — items (chronological), agent status, commands (WS + DB)
 *  - useChatActions   — sendMessage, respond, addSystemMessage
 *  - useChatAnimations — keyboard offset
 *  - MessageList      — inverted rendering (newest at visual bottom)
 *
 * See docs/chat-scroll-architecture.md for full design rationale.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { Alert, Animated } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import * as Clipboard from 'expo-clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDB } from '../../../db/DBProvider'
import { serverDisplayName, DEFAULT_CHANNEL, deleteItem } from '../../../db/database'
import { useWS } from '../../../context/WebSocketContext'
import { useTheme } from '../../../context/ThemeContext'
import type { Item } from '../../../hooks/chatTypes'
import { useChatSession } from '../../../hooks/useChatSession'
import { useChatActions, LOCAL_COMMANDS } from '../../../hooks/useChatActions'
import { useKeyboardOffset } from '../../../hooks/useChatAnimations'
import { ChatHeader } from '../../../components/headers/ChatHeader'
import { Composer } from '../../../components/chat/Composer'
import { MessageList } from '../../../components/chat/MessageList'
import type { MessageListHandle } from '../../../components/chat/MessageList'
import { CommandPicker } from '../../../components/chat/CommandPicker'
import { Row } from '../../../components/chat/MessageRow'
import { MessageActionMenu, messageCopyText } from '../../../components/chat/MessageActionMenu'
import type { MessageMenuTarget, Rect } from '../../../components/chat/MessageActionMenu'
import { ToolSheet } from '../../../components/chat/ToolSheet'
import { FileViewer } from '../../../components/chat/FileViewer'

type FileItem = Extract<Item, { kind: 'file' }>

export default function ChatScreen() {
  const { serverId, channelId } = useLocalSearchParams<{
    serverId?: string | string[]
    channelId?: string | string[]
  }>()
  const resolvedServerId = useMemo(() => {
    const v = Array.isArray(serverId) ? serverId[0] : serverId
    return v?.trim() ? v : undefined
  }, [serverId])
  const resolvedChannel = useMemo(() => {
    const v = Array.isArray(channelId) ? channelId[0] : channelId
    return v?.trim() ? v : DEFAULT_CHANNEL
  }, [channelId])

  const db = useDB()
  const { conn, sendEvent, subscribe } = useWS()
  const { colors } = useTheme()

  const { bottom: safeBottom } = useSafeAreaInsets()
  const [draft, setDraft] = useState('')
  const [isToolSheetOpen, setIsToolSheetOpen] = useState<Item[] | null>(null)
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null)
  const [menuTarget, setMenuTarget] = useState<MessageMenuTarget | null>(null)
  const messageListRef = useRef<MessageListHandle | null>(null)

  const {
    items,
    setItems,
    agentStatus,
    commands,
    hasMoreOlder,
    loadOlder,
  } = useChatSession(resolvedServerId, resolvedChannel, db, conn, subscribe, sendEvent)

  const { sendMessage, sendAudio, sendAttachment, respond } = useChatActions({ chatId: resolvedServerId, channel: resolvedChannel, db, conn, sendEvent, items, setItems })
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
      // 'heavy' exactly where the avatar group breaks (sender changes), 'light'
      // within a same-sender run. Mirrors computeIsGroupStart's boundary.
      map.set(cur.id, senderRole(cur) !== senderRole(next) ? 'heavy' : 'light')
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

  const serverName = resolvedServerId ? serverDisplayName(resolvedServerId) : 'Chat'
  const avatarLabel = useMemo(() => getAvatarLabel(serverName), [serverName])
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

  const handleSendAudio = useCallback((uri: string, durationMs: number) => {
    sendAudio(uri, durationMs).catch(console.warn)
    messageListRef.current?.scrollToBottom()
  }, [sendAudio])

  // ── Attachment handlers ──────────────────────────────────────────────────

  const handleAttachCamera = useCallback(async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Camera access required', 'Allow camera access in Settings to send photos.')
      return
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85,
    })
    if (result.canceled) return
    const asset = result.assets[0]
    sendAttachment({ uri: asset.uri, mime: asset.mimeType ?? 'image/jpeg', name: asset.fileName ?? undefined }).catch(console.warn)
    messageListRef.current?.scrollToBottom()
  }, [sendAttachment])

  const handleAttachPhoto = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Photo library access required', 'Allow photo library access in Settings to share images.')
      return
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85,
    })
    if (result.canceled) return
    const asset = result.assets[0]
    sendAttachment({ uri: asset.uri, mime: asset.mimeType ?? 'image/jpeg', name: asset.fileName ?? undefined }).catch(console.warn)
    messageListRef.current?.scrollToBottom()
  }, [sendAttachment])

  const handleAttachFile = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true })
    if (result.canceled) return
    const asset = result.assets[0]
    sendAttachment({ uri: asset.uri, mime: asset.mimeType ?? 'application/octet-stream', name: asset.name }).catch(console.warn)
    messageListRef.current?.scrollToBottom()
  }, [sendAttachment])

  const handleCommandSelect = useCallback((name: string) => {
    setDraft(`/${name} `)
  }, [])

  // ── Long-press message menu (copy / delete) ───────────────────────────────

  const handleLongPressItem = useCallback((item: Item, rect: Rect) => {
    setMenuTarget({ item, rect })
  }, [])

  const handleCopyItem = useCallback(async (item: Item) => {
    const text = messageCopyText(item)
    if (text) await Clipboard.setStringAsync(text)
  }, [])

  const handleDeleteItem = useCallback((item: Item) => {
    // Local-only delete ("delete for me"): the protocol has no single-message
    // delete and history is local-first, so we drop it from the window + SQLite.
    Alert.alert(
      'Delete message',
      'Remove this message from this device? This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setItems((prev) => prev.filter((it) => it.id !== item.id))
            deleteItem(db, item.id).catch(console.warn)
          },
        },
      ],
    )
  }, [db, setItems])

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
          onOpenFile={setSelectedFile}
          onLongPressItem={handleLongPressItem}
        />
      )
    },
    [groupStartIds, dividerMap, toolsByAgentMsgId, respond, avatarLabel, handleLongPressItem],
  )

  return (
    <Animated.View style={{ flex: 1, backgroundColor: colors.bg, paddingBottom: kbOffset }}>
      <ChatHeader
        displayName={serverName}
        channel={resolvedChannel}
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
      <Composer
        draft={draft}
        setDraft={setDraft}
        onSend={handleSend}
        canSend={canSend}
        blocked={hasPendingPrompt}
        onSendAudio={handleSendAudio}
        onAttachCamera={handleAttachCamera}
        onAttachPhoto={handleAttachPhoto}
        onAttachFile={handleAttachFile}
      />
      <ToolSheet
        tools={isToolSheetOpen ?? []}
        visible={isToolSheetOpen !== null}
        onClose={() => setIsToolSheetOpen(null)}
      />
      <FileViewer item={selectedFile} onClose={() => setSelectedFile(null)} />
      <MessageActionMenu
        target={menuTarget}
        onClose={() => setMenuTarget(null)}
        onCopy={handleCopyItem}
        onDelete={handleDeleteItem}
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
 * The sender of an item for grouping/divider purposes. Messages and files carry
 * a role; tool/prompt items have no sender and always break a run (null).
 */
function senderRole(item: Item): 'assistant' | 'user' | 'system' | null {
  return item.kind === 'message' || item.kind === 'file' ? item.role : null
}

/**
 * A message/file starts a new group (avatar + name header shown) when the sender
 * changes. Consecutive items from the same sender — regardless of turn — share
 * one group, so the agent avatar shows ONCE per run instead of repeating on every
 * message (including separate turns and turn-less cron pushes). Tool/prompt items
 * (null sender) always start a new group.
 */
function computeIsGroupStart(item: Item, prev: Item | undefined): boolean {
  const role = senderRole(item)
  if (role === null) return true
  if (!prev) return true
  return senderRole(prev) !== role
}
