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
import { useMemo, useRef, useState } from 'react'
import { Animated } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDB } from '../../../db/DBProvider'
import { serverDisplayName } from '../../../db/database'
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
import { useAttachmentActions } from '../../../hooks/chatScreen/useAttachmentActions'
import { useMessageActions } from '../../../hooks/chatScreen/useMessageActions'
import { useChatInputActions } from '../../../hooks/chatScreen/useChatInputActions'
import { useChatRowRenderer } from '../../../hooks/chatScreen/useChatRowRenderer'
import { ChatHeader } from '../../../components/headers/ChatHeader'
import { Composer } from '../../../components/chat/Composer'
import { MessageList } from '../../../components/chat/MessageList'
import type { MessageListHandle } from '../../../components/chat/MessageList'
import { CommandPicker } from '../../../components/chat/CommandPicker'
import { ModelPicker } from '../../../components/chat/ModelPicker'
import { avatarInitials } from '../../../components/chat/Avatar'
import { MessageActionMenu } from '../../../components/chat/MessageActionMenu'
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
  const {
    menuTarget,
    handleLongPressItem,
    closeMessageMenu,
    handleCopyItem,
    handleDeleteItem,
  } = useMessageActions({ db, setItems })
  const {
    handleAttachCamera,
    handleAttachPhoto,
    handleAttachFile,
  } = useAttachmentActions({
    sendAttachment,
    onAttachmentSent: () => messageListRef.current?.scrollToBottom(),
  })

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
  const {
    showModelPicker,
    setShowModelPicker,
    activeModel,
    handleSend,
    handleSendAudio,
    handleCommandSelect,
    handleModelSelect,
  } = useChatInputActions({
    trimmedDraft,
    setDraft,
    sendMessage,
    sendAudio,
    onScrollToBottom: () => messageListRef.current?.scrollToBottom(),
  })

  const serverName = resolvedServerId ? serverDisplayName(resolvedServerId) : 'Chat'
  const avatarLabel = useMemo(() => avatarInitials(serverName), [serverName])
  const canSend = trimmedDraft.length > 0 && conn === 'connected' && (!hasPendingPrompt || trimmedDraft.startsWith('/'))

  const renderItem = useChatRowRenderer({
    groupStartIds,
    dividerMap,
    daySeparators,
    newMessagesDividerId,
    toolsByAgentMsgId,
    respond,
    avatarLabel,
    serverId: resolvedServerId,
    channelId: resolvedChannel,
    serverName,
    onOpenTools: setIsToolSheetOpen,
    onOpenFile: setSelectedFile,
    onLongPressItem: handleLongPressItem,
  })

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
        onClose={closeMessageMenu}
        onCopy={handleCopyItem}
        onDelete={handleDeleteItem}
      />
    </Animated.View>
  )
}
