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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Animated, View } from 'react-native'
import { useLocalSearchParams, useFocusEffect } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import * as Clipboard from 'expo-clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDB } from '../../../db/DBProvider'
import { serverDisplayName, DEFAULT_CHANNEL, deleteItem, getChannelLastRead, markChannelRead } from '../../../db/database'
import { syncAppBadge } from '../../../utils/badge'
import { setFocusedChat } from '../../../utils/focusedChat'
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
import { ModelPicker } from '../../../components/chat/ModelPicker'
import { Row } from '../../../components/chat/MessageRow'
import { parseEditDiff } from '../../../components/chat/diffHelpers'
import { avatarInitials } from '../../../components/chat/Avatar'
import { DaySeparator } from '../../../components/chat/DaySeparator'
import { NewMessagesDivider } from '../../../components/chat/NewMessagesDivider'
import { sameCalendarDay, formatDaySeparator } from '../../../components/chat/timeHelpers'
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
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [activeModel, setActiveModel] = useState<string | undefined>()
  const [menuTarget, setMenuTarget] = useState<MessageMenuTarget | null>(null)
  const messageListRef = useRef<MessageListHandle | null>(null)

  const {
    items,
    setItems,
    agentStatus,
    commands,
    hasMoreOlder,
    loadOlder,
  } = useChatSession(resolvedServerId, resolvedChannel, db, subscribe, conn)

  const { sendMessage, sendAudio, sendAttachment, respond } = useChatActions({ chatId: resolvedServerId, channel: resolvedChannel, db, conn, sendEvent, items, setItems })
  const kbOffset = useKeyboardOffset(safeBottom)

  // Capture the channel's unread baseline (last_read_at) BEFORE clearing it, so
  // the "new messages" divider can sit above the first message the user hadn't
  // seen. `openedAt` bounds the divider to messages that were already waiting at
  // open — anything created after (a live reply, or the user's own send) is seen
  // in real time and must not trigger a divider. Re-runs when the target changes.
  const [unreadBaseline, setUnreadBaseline] = useState<number | null>(null)
  const [openedAt, setOpenedAt] = useState<number | null>(null)
  useEffect(() => {
    if (!resolvedServerId) { setUnreadBaseline(null); setOpenedAt(null); return }
    let cancelled = false
    getChannelLastRead(db, resolvedServerId, resolvedChannel)
      .then((ts) => {
        if (cancelled) return
        setUnreadBaseline(ts)
        setOpenedAt(Date.now())
        markChannelRead(db, resolvedServerId, resolvedChannel)
          .then(() => syncAppBadge(db))
          .catch(() => {})
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [db, resolvedServerId, resolvedChannel])

  // Mark this the focused chat while the screen is mounted+focused (so a push
  // for it is suppressed in-app), and re-mark read on blur so messages that
  // streamed in while viewing are cleared from the home + channel-list badges.
  useFocusEffect(
    useCallback(() => {
      if (resolvedServerId) setFocusedChat(resolvedServerId, resolvedChannel)
      return () => {
        setFocusedChat(null)
        if (resolvedServerId) {
          markChannelRead(db, resolvedServerId, resolvedChannel)
            .then(() => syncAppBadge(db))
            .catch(() => {})
        }
      }
    }, [db, resolvedServerId, resolvedChannel]),
  )

  // Edit tools that yield a renderable diff are shown inline as diff cards; the
  // rest (and any edit whose result has no usable change data) fall back to the
  // tool badge. Computed once so grouping + display agree.
  const diffToolIds = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) {
      if (it.kind === 'tool' && parseEditDiff(it.name, it.args, it.result)) set.add(it.id)
    }
    return set
  }, [items])

  const toolsByAgentMsgId = useMemo(() => {
    const map = new Map<string, Item[]>()
    let lastAgentMsgId: string | null = null
    for (const it of items) {
      if (it.kind === 'message' && it.role === 'assistant') {
        lastAgentMsgId = it.id
      } else if (it.kind === 'tool' && !diffToolIds.has(it.id) && lastAgentMsgId) {
        const arr = map.get(lastAgentMsgId) ?? []
        arr.push(it)
        map.set(lastAgentMsgId, arr)
      }
    }
    return map
  }, [items, diffToolIds])

  // Decide which items render. Diff-rendered edit tools stay (inline diff cards);
  // all other tools are hidden (they surface via the tool badge). Ghost agent
  // messages (done, no text, no badge) are dropped — they arise when message_end
  // arrives with no preceding text_delta, producing an empty wrapper + divider.
  const displayItems = useMemo(() => items.filter((it) => {
    if (it.kind === 'tool') return diffToolIds.has(it.id)
    if (it.kind === 'message' && it.role !== 'user' && it.done && !it.text.trim()) {
      return (toolsByAgentMsgId.get(it.id)?.length ?? 0) > 0
    }
    return true
  }), [items, diffToolIds, toolsByAgentMsgId])

  const hasPendingPrompt = useMemo(
    () => displayItems.some((it) => it.kind === 'prompt' && !it.resolved),
    [displayItems],
  )

  // Show the typing indicator when the agent is active. Two paths:
  //   1. Explicit status events (Claude Code, Hermes): use agentStatus directly.
  //      No hasStreaming suppression here — rapid agents batch status + text_delta
  //      into one React render, so the indicator would never be visible otherwise.
  //   2. Inferred from items (fallback for agents without status events): a running
  //      tool (done:false) or an empty in-flight assistant message.
  //      For the inferred path only: hide when streaming text is already visible,
  //      since the bubble itself signals activity.
  const typingStatus = useMemo((): 'thinking' | 'working' | undefined => {
    if (agentStatus !== 'idle') return agentStatus as 'thinking' | 'working'

    const hasStreaming = items.some(
      (it) => it.kind === 'message' && it.role === 'assistant' && !it.done && it.text.trim().length > 0,
    )
    if (hasStreaming) return undefined

    const hasInFlight = items.some(
      (it) =>
        (it.kind === 'tool' && !it.done) ||
        (it.kind === 'message' && it.role === 'assistant' && !it.done && it.text.trim().length === 0),
    )
    return hasInFlight ? 'working' : undefined
  }, [agentStatus, items])

  // Single pass over chronological displayItems to build all per-item rendering metadata.
  // Id-based maps (not index-based) because MessageList reverses items for the inverted
  // FlatList — renderItem's `index` is the nth-newest, not nth-chronological.
  //  - groupStartIds: items that open a new sender group (avatar + name header shown)
  //  - dividerMap: 'heavy' on sender transitions, 'light' within a run, 'none' at tail
  //  - daySeparators: label for the first item in each new calendar day
  const { groupStartIds, dividerMap, daySeparators } = useMemo(() => {
    const groupStartIds = new Set<string>()
    const dividerMap = new Map<string, 'light' | 'heavy' | 'none'>()
    const daySeparators = new Map<string, string>()
    let prev: Item | undefined
    let prevTs: number | undefined
    for (let i = 0; i < displayItems.length; i++) {
      const cur = displayItems[i]
      const next = displayItems[i + 1]
      if (computeIsGroupStart(cur, prev)) groupStartIds.add(cur.id)
      dividerMap.set(cur.id, !next ? 'none' : senderRole(cur) !== senderRole(next) ? 'heavy' : 'light')
      const ts = cur.createdAt
      if (ts != null) {
        if (prevTs == null || !sameCalendarDay(prevTs, ts)) daySeparators.set(cur.id, formatDaySeparator(ts))
        prevTs = ts
      }
      prev = cur
    }
    return { groupStartIds, dividerMap, daySeparators }
  }, [displayItems])

  // Id of the first item the user hadn't seen when they opened the chat — gets a
  // "New messages" divider above it. Constraints:
  //  - there must be an already-read item before it (a never-opened channel and
  //    a brand-new first message show no divider);
  //  - it must predate `openedAt` — i.e. it was already waiting at open. Messages
  //    created after open (the user's own sends, or a live streaming reply) are
  //    seen in real time, so the first item past the baseline that is newer than
  //    `openedAt` means nothing was actually unread → no divider.
  const newMessagesDividerId = useMemo(() => {
    if (unreadBaseline == null || openedAt == null) return null
    let hasReadBefore = false
    for (const it of displayItems) {
      const ts = it.createdAt
      if (ts == null) continue
      if (ts > unreadBaseline) {
        return ts <= openedAt && hasReadBefore ? it.id : null
      }
      hasReadBefore = true
    }
    return null
  }, [displayItems, unreadBaseline, openedAt])

  const allCommands = useMemo(() => [...LOCAL_COMMANDS, ...commands], [commands])

  const modelSubcommands = useMemo(
    () => allCommands.find((c) => c.name === 'model')?.subcommands ?? [],
    [allCommands],
  )

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
  const avatarLabel = useMemo(() => avatarInitials(serverName), [serverName])
  const canSend = trimmedDraft.length > 0 && conn === 'connected' && (!hasPendingPrompt || trimmedDraft.startsWith('/'))

  const handleSend = useCallback(() => {
    const text = trimmedDraft
    if (!text) return
    // Intercept /model with no args — open the picker instead of sending to server.
    if (text === '/model') {
      setShowModelPicker(true)
      setDraft('')
      return
    }
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

  const handleAttach = useCallback(async (mode: 'camera' | 'photo' | 'file') => {
    if (mode === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync()
      if (!perm.granted) {
        Alert.alert('Camera access required', 'Allow camera access in Settings to send photos.')
        return
      }
    } else if (mode === 'photo') {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!perm.granted) {
        Alert.alert('Photo library access required', 'Allow photo library access in Settings to share images.')
        return
      }
    }

    let uri: string, mime: string, name: string | undefined
    if (mode === 'file') {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true })
      if (result.canceled) return
      const asset = result.assets[0]
      uri = asset.uri; mime = asset.mimeType ?? 'application/octet-stream'; name = asset.name
    } else {
      const result = mode === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.85 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.85 })
      if (result.canceled) return
      const asset = result.assets[0]
      uri = asset.uri; mime = asset.mimeType ?? 'image/jpeg'; name = asset.fileName ?? undefined
    }

    sendAttachment({ uri, mime, name }).catch(console.warn)
    messageListRef.current?.scrollToBottom()
  }, [sendAttachment])

  const handleAttachCamera = useCallback(() => handleAttach('camera'), [handleAttach])
  const handleAttachPhoto = useCallback(() => handleAttach('photo'), [handleAttach])
  const handleAttachFile = useCallback(() => handleAttach('file'), [handleAttach])

  const handleCommandSelect = useCallback((name: string) => {
    if (name === 'model') {
      setShowModelPicker(true)
      setDraft('')
      return
    }
    setDraft(`/${name} `)
  }, [])

  const handleModelSelect = useCallback((modelId: string) => {
    setActiveModel(modelId)
    sendMessage(`/model ${modelId}`)
    messageListRef.current?.scrollToBottom()
  }, [sendMessage])

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
      const daySeparator = daySeparators.get(item.id)
      // Wrap in a plain View (not a Fragment): the inverted FlatList cell wrapper
      // is `flexDirection: column-reverse`, which would otherwise render these
      // siblings bottom-to-top (divider/day-separator below the Row). A single
      // child View isolates our intended top-to-bottom order from that reversal.
      return (
        <View>
          {daySeparator ? <DaySeparator label={daySeparator} /> : null}
          {item.id === newMessagesDividerId ? <NewMessagesDivider /> : null}
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
            serverId={resolvedServerId}
            channelId={resolvedChannel}
            serverName={serverName}
          />
        </View>
      )
    },
    [groupStartIds, dividerMap, daySeparators, newMessagesDividerId, toolsByAgentMsgId, respond, avatarLabel, handleLongPressItem, resolvedServerId, resolvedChannel, serverName],
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
        typingStatus={typingStatus}
        avatarLabel={avatarLabel}
        serverName={serverName}
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
      <ModelPicker
        visible={showModelPicker}
        models={modelSubcommands}
        currentModel={activeModel}
        onSelect={handleModelSelect}
        onClose={() => setShowModelPicker(false)}
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
