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
import { useLocalSearchParams } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import * as Clipboard from 'expo-clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDB } from '../../../db/DBProvider'
import { serverDisplayName, deleteItem } from '../../../db/database'
import { useWS } from '../../../context/WebSocketContext'
import { useTheme } from '../../../context/ThemeContext'
import type { Item } from '../../../hooks/chatTypes'
import { useChatSession } from '../../../hooks/useChatSession'
import { useChatActions } from '../../../hooks/useChatActions'
import { useKeyboardOffset } from '../../../hooks/useChatAnimations'
import { useChatDisplayDerivations } from '../../../hooks/chatScreen/useChatDisplayDerivations'
import { useCommandPicker } from '../../../hooks/chatScreen/useCommandPicker'
import { useResolvedChatParams } from '../../../hooks/chatScreen/useResolvedChatParams'
import { useUnreadTracking } from '../../../hooks/chatScreen/useUnreadTracking'
import { ChatHeader } from '../../../components/headers/ChatHeader'
import { Composer } from '../../../components/chat/Composer'
import { MessageList } from '../../../components/chat/MessageList'
import type { MessageListHandle } from '../../../components/chat/MessageList'
import { CommandPicker } from '../../../components/chat/CommandPicker'
import { ModelPicker } from '../../../components/chat/ModelPicker'
import { Row } from '../../../components/chat/MessageRow'
import { avatarInitials } from '../../../components/chat/Avatar'
import { DaySeparator } from '../../../components/chat/DaySeparator'
import { NewMessagesDivider } from '../../../components/chat/NewMessagesDivider'
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
  const { resolvedServerId, resolvedChannel } = useResolvedChatParams({ serverId, channelId })

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

  const { unreadBaseline, openedAt } = useUnreadTracking({
    db,
    resolvedServerId,
    resolvedChannel,
  })

  const {
    toolsByAgentMsgId,
    displayItems,
    hasPendingPrompt,
    typingStatus,
    groupStartIds,
    dividerMap,
    daySeparators,
    newMessagesDividerId,
  } = useChatDisplayDerivations({
    items,
    agentStatus,
    unreadBaseline,
    openedAt,
  })

  const { modelSubcommands, trimmedDraft, pickerItems } = useCommandPicker(draft, commands)

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
