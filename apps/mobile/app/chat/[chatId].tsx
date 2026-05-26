/**
 * Per-agent chat screen.
 *
 * On mount:
 *  1. Loads full item history from SQLite for this agent
 *  2. Subscribes to live WS events filtered to this agent
 *  3. Appends/updates in-memory items as events stream in
 *
 * No WebSocket management here — that lives in WSProvider (context).
 */
import { Component, ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useDB } from '../../db/DBProvider'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { AgentStatus, CommandItem, PromptOption, ServerEvent } from '@aji/protocol'
import { newId } from '@aji/protocol'
import { MarkdownMessage } from '../../components/MarkdownMessage'
import { useWS } from '../../context/WebSocketContext'
import { useTheme } from '../../context/ThemeContext'
import {
  agentDisplayName,
  clearAgentHistory,
  getDbDump,
  getItemsForAgent,
  insertItem,
  updateAgentPreview,
  upsertAgent,
  wipeAllHistory,
  type ItemRow,
} from '../../db/database'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'

const SERVER_PORT = process.env.EXPO_PUBLIC_SERVER_PORT ?? '4000'
const SERVER_HTTP = `http://${process.env.EXPO_PUBLIC_SERVER_HOST}:${SERVER_PORT}`

// Prevents indefinite hangs when the LAN server is unreachable
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 5000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Local slash commands — handled client-side, never forwarded to the server
// ---------------------------------------------------------------------------

const LOCAL_COMMANDS: CommandItem[] = [
  { name: 'clear',             description: 'Clear chat history for this agent',                  category: 'Dev' },
  { name: 'view-db',           description: 'Dump database contents to server log',               category: 'Dev' },
  { name: 'view-chat-history', description: "Log this agent's chat messages to server console",   category: 'Dev', args_hint: '[with-tools]' },
  { name: 'view-last-n-msgs',  description: 'Log the last N messages to server console',          category: 'Dev', args_hint: '<count>' },
  { name: 'wipe-db',           description: 'Wipe ALL history for ALL agents',                    category: 'Dev' },
]

// ---------------------------------------------------------------------------
// Local command handlers — module-level constant, not a factory
// ---------------------------------------------------------------------------

type CommandHandler = (args: string[]) => Promise<void>

interface LocalCommandHandlerMap {
  [name: string]: (ctx: {
    chatId?: string
    db: any
    items: Item[]
    setItems: (updater: (prev: Item[]) => Item[]) => void
    addSystemMessage: (text: string) => void
    router: any
  }) => CommandHandler
}

const LOCAL_COMMAND_HANDLERS: LocalCommandHandlerMap = {
  clear: (ctx) => async () => {
    await clearAgentHistory(ctx.db, ctx.chatId ?? 'unknown')
    ctx.setItems(() => [])
    ctx.addSystemMessage('Chat history cleared.')
  },

  'view-db': (ctx) => async () => {
    const dump = await getDbDump(ctx.db)
    try {
      await fetchWithTimeout(`${SERVER_HTTP}/db/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dump),
      })
      ctx.addSystemMessage('DB dump sent to server log.')
    } catch {
      ctx.addSystemMessage('Could not reach server — is it running?')
    }
  },

  'view-chat-history': (ctx) => async (args) => {
    const withTools = args.includes('with-tools')
    const snapshot = ctx.items.filter(
      (it): it is Extract<Item, { kind: 'message' | 'tool' }> =>
        it.kind === 'message' || (withTools && it.kind === 'tool'),
    )
    const payload = snapshot.map((it) =>
      it.kind === 'tool'
        ? { kind: 'tool' as const, name: it.name, args: it.args, result: it.result, done: it.done }
        : { kind: 'message' as const, role: it.role, text: it.text, done: it.done },
    )
    try {
      await fetchWithTimeout(`${SERVER_HTTP}/chat/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: ctx.chatId ?? 'unknown', items: payload }),
      })
      ctx.addSystemMessage(`Chat history sent to server log${withTools ? ' (with tools)' : ''}.`)
    } catch {
      ctx.addSystemMessage('Could not reach server — is it running?')
    }
  },

  'view-last-n-msgs': (ctx) => async (args) => {
    const countStr = args[0] || '10'
    const count = Math.max(1, parseInt(countStr, 10) || 10)
    const messages = ctx.items
      .filter((it): it is Extract<Item, { kind: 'message' }> => it.kind === 'message')
      .slice(-count)
    try {
      await fetchWithTimeout(`${SERVER_HTTP}/last-messages/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: ctx.chatId ?? 'unknown', messages }),
      })
      ctx.addSystemMessage(`Last ${count} message${count !== 1 ? 's' : ''} sent to server log.`)
    } catch {
      ctx.addSystemMessage('Could not reach server — is it running?')
    }
  },

  'wipe-db': (ctx) => async () => {
    await wipeAllHistory(ctx.db)
    ctx.setItems(() => [])
    ctx.router.replace('/')
  },
}

// ---------------------------------------------------------------------------
// Item types (in-memory, deserialized from DB JSON blobs)
// ---------------------------------------------------------------------------

type Item =
  | { kind: 'message'; id: string; role: 'assistant' | 'user' | 'system'; text: string; done: boolean; turnId?: string }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; result?: unknown; done: boolean; turnId?: string }
  | { kind: 'prompt'; id: string; title: string; message: string; options: PromptOption[]; turnId?: string }

function rowToItem(row: ItemRow): Item {
  return JSON.parse(row.data) as Item
}

// ---------------------------------------------------------------------------
// Out-of-order event resilience helper
// ---------------------------------------------------------------------------

/**
 * Ensure a message exists in the items array. Creates it if missing.
 * Used only for out-of-order guards on message_start and text_delta — NOT for
 * message_end (which must update an existing item, not just create one).
 */
function ensureMessageExists(
  items: Item[],
  messageId: string,
  turnId: string | undefined,
): Item[] {
  if (items.some((it) => it.kind === 'message' && it.id === messageId)) return items
  return [...items, { kind: 'message', id: messageId, role: 'assistant', text: '', done: false, turnId }]
}

// ---------------------------------------------------------------------------
// Chat screen
// ---------------------------------------------------------------------------

export default function ChatScreen() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>()
  const db = useDB()
  const { conn, sendEvent, subscribe } = useWS()
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [items, setItems] = useState<Item[]>([])
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle')
  const [draft, setDraft] = useState('')
  const [commands, setCommands] = useState<CommandItem[]>([])

  const listRef = useRef<FlatList>(null)
  const { top: safeTop, bottom: safeBottom } = useSafeAreaInsets()

  // Status indicator pulse animation
  const pulseScale = useRef(new Animated.Value(1)).current

  // kbOffset lazy-init: uses safeBottom as a dynamic initial value so the
  // resting position is correct even before the first keyboard event fires.
  const kbOffsetRef = useRef<Animated.Value | null>(null)
  if (!kbOffsetRef.current) kbOffsetRef.current = new Animated.Value(safeBottom)
  const kbOffset = kbOffsetRef.current

  // true when the list is scrolled within 150px of the bottom — gates auto-scroll
  const isNearBottomRef = useRef(true)
  // Two-step wipe guard: set to true on first /wipe-db, cleared after 10s or on confirm
  const wipePendingRef = useRef(false)
  const wipePendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // IDs already written to SQLite — prevents double-writes on remount
  const persistedIdsRef = useRef(new Set<string>())
  // Stable snapshot of items for command handlers — avoids items as a useCallback dep
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])

  // Keyboard animation (iOS only)
  useEffect(() => {
    if (Platform.OS !== 'ios') return
    const onShow = Keyboard.addListener('keyboardWillShow', (e) => {
      Animated.timing(kbOffset, {
        toValue: e.endCoordinates.height,
        duration: e.duration,
        useNativeDriver: false,
      }).start()
    })
    const onHide = Keyboard.addListener('keyboardWillHide', (e) => {
      Animated.timing(kbOffset, { toValue: safeBottom, duration: e.duration, useNativeDriver: false }).start()
    })
    return () => { onShow.remove(); onHide.remove() }
  }, [kbOffset, safeBottom])

  // Pulse animation for status indicator — loop when working/thinking, reset when idle
  useEffect(() => {
    if (agentStatus === 'idle') {
      Animated.timing(pulseScale, { toValue: 1, duration: 0, useNativeDriver: true }).start()
      return
    }
    const pulse = () => {
      Animated.sequence([
        Animated.timing(pulseScale, { toValue: 1.3, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseScale, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]).start(({ finished }) => { if (finished) pulse() })
    }
    pulse()
  }, [agentStatus, pulseScale])

  // Load history from SQLite on mount.
  // Uses a functional update so that any in-flight items that arrived via WS
  // while the async DB read was in progress are not clobbered.
  // Filters out incomplete streaming messages (done: false on assistant/system)
  // to avoid rehydrating orphaned cursors when the user navigates back.
  useEffect(() => {
    if (!chatId) return
    getItemsForAgent(db, chatId).then((rows) => {
      // Mark all existing DB rows as already persisted before updating state
      rows.forEach((row) => persistedIdsRef.current.add(row.id))
      setItems((current) => {
        // Deduplicate by id using a Map (last-row-wins by insertion order).
        // The items table has no UNIQUE constraint on id, so duplicate rows
        // are possible if insertItem was ever called twice for the same message.
        const seen = new Map<string, Item>()
        for (const row of rows) {
          const item = rowToItem(row)
          if (item.kind === 'message' && item.role !== 'user' && !item.done) continue
          if (!seen.has(item.id)) seen.set(item.id, item)
        }
        const dbItems = [...seen.values()]
        if (current.length === 0) return dbItems
        const dbIds = new Set(dbItems.map((i) => i.id))
        const inFlight = current.filter((i) => !dbIds.has(i.id))
        return [...dbItems, ...inFlight]
      })
    })
  }, [db, chatId])

  // Clear stale server-sent commands when the connection drops
  useEffect(() => {
    if (conn === 'disconnected') setCommands([])
  }, [conn])

  // Persist completed assistant messages so they survive navigation.
  // persistedIdsRef prevents double-writes; only new done:true assistant messages
  // that haven't been written to DB yet are inserted.
  useEffect(() => {
    if (!chatId) return
    const toPersist = items.filter(
      (it): it is Extract<Item, { kind: 'message' }> =>
        it.kind === 'message' &&
        it.role === 'assistant' &&
        it.done &&
        !persistedIdsRef.current.has(it.id),
    )
    for (const msg of toPersist) {
      persistedIdsRef.current.add(msg.id)
      upsertAgent(db, chatId)
        .then(() => insertItem(db, { id: msg.id, chatId, kind: 'message', data: msg, turnId: msg.turnId }))
        .catch(console.warn)
    }
  }, [items, chatId, db])

  // ---------------------------------------------------------------------------
  // Event handler — declared before subscribe effect so it can be a dep
  // ---------------------------------------------------------------------------
  // Events may arrive out of sequence due to HTTP request reordering or
  // async scheduling in the adapter. ensureMessageExists() guards against
  // missing message_start events:
  //   • text_delta before message_start → creates placeholder on the fly
  //   • message_start after text_delta → skips (item already exists)
  //   • message_end before message_start → creates done:true placeholder
  //   • Normal order (start → delta(s) → end) → works as expected

  const handleEvent = useCallback((event: ServerEvent) => {
    const turnId = 'turn_id' in event ? (event.turn_id as string | undefined) : undefined

    setItems((prev) => {
      switch (event.type) {
        case 'message_start':
          return ensureMessageExists(prev, event.id, turnId)

        case 'text_delta': {
          const updated = ensureMessageExists(prev, event.id, turnId)
          return updated.map((it) =>
            it.kind === 'message' && it.id === event.id
              ? { ...it, text: it.text + event.text }
              : it,
          )
        }

        case 'message_end': {
          // If the message exists, mark it done — triggers markdown render.
          // If it arrived before message_start (out-of-order), create a
          // done:true placeholder so later text_deltas have somewhere to land.
          const exists = prev.some((it) => it.kind === 'message' && it.id === event.id)
          if (exists) {
            return prev.map((it) =>
              it.kind === 'message' && it.id === event.id ? { ...it, done: true } : it,
            )
          }
          return [...prev, { kind: 'message', id: event.id, role: 'assistant', text: '', done: true, turnId }]
        }

        case 'tool_start':
          // Deduplicate in case the server re-delivers on reconnect
          if (prev.some((it) => it.kind === 'tool' && it.id === event.id)) return prev
          return [...prev, { kind: 'tool', id: event.id, name: event.name, args: event.args, done: false, turnId }]

        case 'tool_end':
          return prev.map((it) =>
            it.kind === 'tool' && it.id === event.id
              ? { ...it, result: event.result, done: true }
              : it,
          )

        case 'permission_request':
          if (prev.some((it) => it.kind === 'prompt' && it.id === event.id)) return prev
          return [...prev, { kind: 'prompt', id: event.id, title: event.title, message: event.message, options: event.options, turnId }]

        case 'clarify':
          if (prev.some((it) => it.kind === 'prompt' && it.id === event.id)) return prev
          return [...prev, { kind: 'prompt', id: event.id, title: 'Clarification', message: event.question, options: event.choices, turnId }]

        case 'prompt_dismiss':
          return prev.filter((it) => !(it.kind === 'prompt' && it.id === event.id))

        default:
          return prev
      }
    })

    if (event.type === 'status') setAgentStatus(event.value)
    if (event.type === 'commands') setCommands(event.commands)
  }, [])

  // Subscribe to live events for this chat
  useEffect(() => {
    if (!chatId) return
    return subscribe(chatId, handleEvent)
  }, [chatId, subscribe, handleEvent])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const respond = useCallback((promptId: string, choice: string) => {
    sendEvent({ type: 'prompt_response', id: promptId, choice })
    setItems((prev) => prev.filter((it) => !(it.kind === 'prompt' && it.id === promptId)))
  }, [sendEvent])

  const addSystemMessage = useCallback((text: string) => {
    setItems((prev) => [
      ...prev,
      { kind: 'message', id: newId('sys'), role: 'system', text, done: true },
    ])
  }, [])

  // ---------------------------------------------------------------------------
  // Local command dispatch — uses itemsRef so items isn't a dep (avoids
  // recreating this callback on every streamed message)
  // ---------------------------------------------------------------------------

  const handleLocalCommand = useCallback(async (cmd: string, args: string[] = []): Promise<boolean> => {
    const handler = LOCAL_COMMAND_HANDLERS[cmd]
    if (!handler) return false

    // Two-step guard for the irreversible wipe command
    if (cmd === 'wipe-db') {
      if (!wipePendingRef.current) {
        wipePendingRef.current = true
        wipePendingTimerRef.current = setTimeout(() => { wipePendingRef.current = false }, 10000)
        addSystemMessage('⚠️ This will wipe ALL history for ALL agents. Type /wipe-db confirm within 10s to proceed.')
        return true
      }
      if (args[0] !== 'confirm') {
        addSystemMessage('Type /wipe-db confirm to proceed, or wait for the 10s timeout to cancel.')
        return true
      }
      wipePendingRef.current = false
      if (wipePendingTimerRef.current) {
        clearTimeout(wipePendingTimerRef.current)
        wipePendingTimerRef.current = null
      }
    }

    const context = { chatId, db, items: itemsRef.current, setItems, addSystemMessage, router }
    try {
      await handler(context)(args)
      return true
    } catch (err) {
      console.error(`Command /${cmd} failed:`, err)
      addSystemMessage(`Error running /${cmd}: ${err instanceof Error ? err.message : 'unknown error'}`)
      return true
    }
  }, [chatId, db, addSystemMessage])

  const sendMessage = useCallback(() => {
    const text = draft.trim()
    if (!text) return

    // Intercept local commands before sending to the server
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/)
      const cmd = parts[0]
      const args = parts.slice(1)
      if (LOCAL_COMMANDS.some((c) => c.name === cmd)) {
        setDraft('')
        handleLocalCommand(cmd, args).catch(console.warn)
        return
      }
    }

    if (conn !== 'connected') return

    // Generate ID up-front so both in-memory state and DB use the same one
    const msgId = newId('msg')
    const msgData = { kind: 'message' as const, id: msgId, role: 'user' as const, text, done: true }

    setItems((prev) => [...prev, msgData])
    sendEvent({ type: 'user_message', text })
    setDraft('')

    // Persist to DB so the message survives navigation (fire-and-forget)
    if (chatId) {
      upsertAgent(db, chatId)
        .then(() => insertItem(db, { id: msgId, chatId, kind: 'message', data: msgData }))
        .then(() => updateAgentPreview(db, chatId, text))
        .catch(console.warn)
    }
  }, [draft, conn, chatId, db, sendEvent, handleLocalCommand])

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  // Pre-compute set of turnIds that have at least one tool call — O(n) once
  // instead of O(n) per rendered row
  const toolTurnIds = useMemo(
    () =>
      new Set(
        items
          .filter((it): it is Extract<Item, { kind: 'tool' }> => it.kind === 'tool')
          .map((it) => it.turnId)
          .filter((id): id is string => id != null),
      ),
    [items],
  )

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

  const showPicker = pickerItems.length > 0

  const canSend = draft.trim().length > 0 && conn === 'connected'
  const displayName = chatId ? agentDisplayName(chatId) : 'Chat'
  const avatarLabel = useMemo(() => getAvatarLabel(displayName), [displayName])

  const renderItem = useCallback(
    ({ item, index }: { item: Item; index: number }) => {
      const prev = items[index - 1]
      const isGroupStart = computeIsGroupStart(item, prev)
      const isLast = index === items.length - 1
      const hasTool =
        item.kind === 'message' && item.turnId != null && toolTurnIds.has(item.turnId)
      return (
        <Row
          item={item}
          onChoose={respond}
          isGroupStart={isGroupStart}
          isLast={isLast}
          hasTool={hasTool}
          avatarLabel={avatarLabel}
        />
      )
    },
    [items, toolTurnIds, respond, avatarLabel],
  )

  return (
    <Animated.View style={[styles.screen, { paddingTop: safeTop + 12, paddingBottom: kbOffset }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{displayName}</Text>
        <StatusIndicator status={agentStatus} pulseScale={pulseScale} connStatus={conn} />
      </View>

      {/* Message list */}
      {items.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.empty}>No messages yet</Text>
        </View>
      ) : (
        <MessageListErrorBoundary colors={colors}>
          <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(it) => `${it.kind}-${it.id}`}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            onScroll={({ nativeEvent }) => {
              const { contentOffset, contentSize, layoutMeasurement } = nativeEvent
              isNearBottomRef.current =
                contentSize.height - contentOffset.y - layoutMeasurement.height < 150
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (isNearBottomRef.current) listRef.current?.scrollToEnd({ animated: true })
            }}
          />
        </MessageListErrorBoundary>
      )}

      {/* Slash command picker */}
      {showPicker && (
        <CommandPicker items={pickerItems} onSelect={(name) => setDraft(`/${name} `)} />
      )}

      {/* Composer */}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message…"
          placeholderTextColor={colors.textDim}
          returnKeyType="send"
          onSubmitEditing={sendMessage}
          blurOnSubmit={false}
        />
        <Pressable
          style={[styles.sendBtn, !canSend && styles.sendBtnOff]}
          onPress={sendMessage}
          disabled={!canSend}
        >
          <Text style={styles.sendBtnText}>↑</Text>
        </Pressable>
      </View>

    </Animated.View>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

class MessageListErrorBoundary extends Component<
  { children: ReactNode; colors: ThemeColors },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
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

function PromptRow({
  item,
  onChoose,
}: {
  item: Extract<Item, { kind: 'prompt' }>
  onChoose: (id: string, choice: string) => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [textValues, setTextValues] = useState<Record<string, string>>({})
  const buttonOpts = item.options.filter((o) => !o.allowText)
  const textOpts = item.options.filter((o) => o.allowText)

  return (
    <View style={styles.promptCard}>
      <Text style={styles.promptTitle}>{item.title}</Text>
      <Text style={styles.promptMsg}>{item.message}</Text>
      {buttonOpts.length > 0 && (
        <View style={styles.promptBtns}>
          {buttonOpts.map((opt, i) => (
            <Pressable
              key={opt.id}
              style={styles.promptBtn}
              onPress={() => onChoose(item.id, opt.id)}
            >
              <Text style={styles.promptBtnNum}>{i + 1}</Text>
              <Text style={styles.promptBtnText}>{opt.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {textOpts.map((opt) => (
        <View key={opt.id} style={styles.textOptWrap}>
          <Text style={styles.textOptLabel}>{opt.label}</Text>
          <View style={styles.textOptRow}>
            <TextInput
              style={styles.textOptInput}
              value={textValues[opt.id] ?? ''}
              onChangeText={(v) => setTextValues((prev) => ({ ...prev, [opt.id]: v }))}
              placeholder="Type your answer…"
              placeholderTextColor={colors.textDim}
              returnKeyType="send"
              onSubmitEditing={() => {
                const val = (textValues[opt.id] ?? '').trim()
                if (val) onChoose(item.id, val)
              }}
            />
            <Pressable
              style={[
                styles.textOptBtn,
                !(textValues[opt.id] ?? '').trim() && styles.textOptBtnOff,
              ]}
              disabled={!(textValues[opt.id] ?? '').trim()}
              onPress={() => {
                const val = (textValues[opt.id] ?? '').trim()
                if (val) onChoose(item.id, val)
              }}
            >
              <Text style={styles.textOptBtnText}>→</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  )
}

function CommandPicker({
  items,
  onSelect,
}: {
  items: CommandItem[]
  onSelect: (name: string) => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.pickerWrap}>
      <FlatList
        data={items}
        keyExtractor={(c) => c.name}
        keyboardShouldPersistTaps="always"
        style={styles.pickerList}
        renderItem={({ item: cmd }) => (
          <Pressable style={styles.pickerRow} onPress={() => onSelect(cmd.name)}>
            <View style={styles.pickerLeft}>
              <Text style={styles.pickerName}>/{cmd.name}</Text>
              {cmd.args_hint ? (
                <Text style={styles.pickerHint}> {cmd.args_hint}</Text>
              ) : null}
            </View>
            <Text style={styles.pickerDesc} numberOfLines={1}>
              {cmd.description}
            </Text>
          </Pressable>
        )}
      />
    </View>
  )
}

// Regex matching common streaming cursor glyphs and simple ANSI show/hide sequences
// - ▉, ▍, █, ▌: block/vertical cursor glyphs seen in different adapters
// - |, _: simple ASCII cursors
// - ANSI `\x1b[?25l` / `\x1b[?25h`: hide/show cursor sequences
const STREAM_CURSOR_RE = /\s*(?:▉|▍|█|▌|\||_|\x1b\[\?25[lh])\s*$/

function stripStreamingCursor(text: string): string {
  return text.replace(STREAM_CURSOR_RE, '')
}

/** Derive short avatar initials from an agent display name. */
function getAvatarLabel(displayName: string): string {
  const words = displayName.trim().split(/\s+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return displayName.slice(0, 2).toUpperCase()
}

/**
 * A message is the start of a new group when:
 * - It is the first item in the list, OR
 * - The previous renderable item is from a different sender, OR
 * - The previous item is a tool/prompt (those break grouping), OR
 * - The current and previous items belong to different turns.
 */
function computeIsGroupStart(item: Item, prev: Item | undefined): boolean {
  if (!prev) return true
  if (item.kind !== 'message') return true
  if (prev.kind !== 'message') return true
  if (item.role !== prev.role) return true
  if (item.turnId && prev.turnId && item.turnId === prev.turnId) return false
  return true
}

/** Reusable avatar badge — agent (purple) or user (accent blue). */
function Avatar({ label, variant }: { label: string; variant: 'agent' | 'user' }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={[styles.avatar, variant === 'user' && styles.avatarUser]}>
      <Text style={[styles.avatarText, variant === 'user' && styles.avatarTextUser]}>
        {label}
      </Text>
    </View>
  )
}

/** Animated status indicator — pulsing dot showing agent state. */
function StatusIndicator({
  status,
  pulseScale,
  connStatus,
}: {
  status: AgentStatus
  pulseScale: Animated.Value
  connStatus: 'connected' | 'connecting' | 'disconnected'
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const statusColor = status === 'idle'
    ? colors.success
    : status === 'thinking'
      ? colors.warn
      : colors.accent // 'working'

  return (
    <View style={styles.statusContainer}>
      <Animated.View
        style={[
          styles.statusDot,
          { backgroundColor: statusColor, transform: [{ scale: pulseScale }] },
        ]}
      />
      {connStatus === 'disconnected' && (
        <View style={[styles.connDot, { backgroundColor: colors.danger }]} />
      )}
    </View>
  )
}

const Row = memo(function Row({
  item,
  onChoose,
  isGroupStart,
  isLast,
  hasTool,
  avatarLabel,
}: {
  item: Item
  onChoose: (id: string, choice: string) => void
  isGroupStart: boolean
  isLast: boolean
  hasTool: boolean
  avatarLabel: string
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  if (item.kind === 'message') {
    const isUser = item.role === 'user'
    const displayText = isUser ? item.text : stripStreamingCursor(item.text)
    // Agent messages only get a bubble when they have associated tool calls
    const showBubble = isUser || hasTool

    return (
      <View style={[styles.msgWrapper, !isLast && styles.msgBorder]}>
        {/* Avatar + author row — first message in each group only */}
        {isGroupStart && (
          <View style={[styles.msgMeta, isUser && styles.msgMetaUserRight]}>
            {!isUser && <Avatar label={avatarLabel} variant="agent" />}
            <Text style={styles.msgAuthor}>{isUser ? 'You' : avatarLabel}</Text>
            {isUser && <Avatar label="You" variant="user" />}
          </View>
        )}

        {/* Content aligned by sender */}
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
              <MarkdownMessage content={displayText} />
            )}
          </View>
        </View>
      </View>
    )
  }

  if (item.kind === 'tool') {
    return (
      <View style={[styles.toolCard, !isLast && styles.msgBorder]}>
        <Text style={styles.toolLabel}>🔧 {item.name} {item.done ? '✓' : '…'}</Text>
        <Text style={styles.toolMono}>{JSON.stringify(item.args)}</Text>
        {item.done && item.result !== undefined && (
          <Text style={styles.toolMono}>
            {typeof item.result === 'string' ? item.result : JSON.stringify(item.result)}
          </Text>
        )}
      </View>
    )
  }

  return <PromptRow item={item} onChoose={onChoose} />
})

// ---------------------------------------------------------------------------
// Style factory — called once per theme change via useMemo
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.sm,
    },
    backBtn: { paddingRight: spacing.xs },
    backText: { color: colors.accent, fontSize: 28, lineHeight: 32 },
    title: { color: colors.text, fontSize: typography.sizeXl, fontWeight: typography.weightSemibold, flex: 1 },
    agentStatus: { color: colors.tool, fontSize: typography.sizeMd, fontStyle: 'italic' },
    dot: { width: 8, height: 8, borderRadius: radius.full },
    // Status indicator — pulsing dot with agent status color
    statusContainer: { position: 'relative', width: 12, height: 12, alignItems: 'center', justifyContent: 'center' },
    statusDot: { width: 8, height: 8, borderRadius: radius.full },
    connDot: { position: 'absolute', width: 4, height: 4, borderRadius: radius.full, bottom: 0, right: 0 },
    emptyWrap: { flex: 1, justifyContent: 'center' },
    empty: { color: colors.textDim, textAlign: 'center', fontSize: typography.sizeLg },
    list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
    // Message wrapper — column layout, optional bottom border between messages
    msgWrapper: {
      flexDirection: 'column',
      paddingVertical: spacing.sm,
    },
    msgBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      paddingBottom: spacing.md,
      marginBottom: spacing.xs,
    },
    // Avatar + author label row (shown once per group)
    msgMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    avatar: {
      width: 28,
      height: 28,
      borderRadius: radius.md,
      backgroundColor: colors.toolDim,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: {
      color: colors.tool,
      fontSize: typography.sizeSm,
      fontWeight: typography.weightSemibold,
    },
    // User avatar — accent tint instead of tool purple
    avatarUser: {
      backgroundColor: colors.accentDim,
    },
    avatarTextUser: {
      color: colors.accent,
    },
    msgAuthor: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
      fontWeight: typography.weightSemibold,
      flex: 1,
    },
    // Alignment wrappers
    msgAlignLeft: { alignItems: 'flex-start' },
    msgAlignRight: { alignItems: 'flex-end' },
    // Right-aligned meta row for user messages (avatar on right)
    // Default flex row order naturally places avatar on right since it renders after text
    msgMetaUserRight: { },
    // Bubble — applied only to user messages and agent messages with tool calls
    bubble: {
      borderRadius: radius.xl,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    bubbleAgent: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    bubbleUser: {
      backgroundColor: colors.accent,
      maxWidth: '85%',
    },
    bubbleText: { color: colors.text, fontSize: typography.sizeLg, lineHeight: typography.lineHeightNormal },
    bubbleTextUser: { color: '#fff' },
    cursor: { color: colors.accent },
    toolCard: {
      backgroundColor: colors.surface2,
      borderRadius: radius.lg,
      padding: spacing.md,
      borderLeftWidth: 3,
      borderLeftColor: colors.tool,
    },
    toolLabel: { color: colors.tool, fontSize: typography.sizeMd, fontWeight: typography.weightSemibold, marginBottom: 4 },
    toolMono: { color: colors.textMuted, fontSize: typography.sizeSm, fontFamily: typography.fontMono, marginTop: 2 },
    promptCard: {
      backgroundColor: colors.surface3,
      borderRadius: radius.xl,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.warn,
    },
    promptTitle: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold, marginBottom: 4 },
    promptMsg: { color: colors.textMuted, fontSize: typography.size, marginBottom: spacing.md },
    promptBtns: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
    promptBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.accent,
      paddingHorizontal: 14,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
    },
    promptBtnNum: { color: 'rgba(255,255,255,0.6)', fontSize: typography.sizeXs, fontWeight: typography.weightBold, minWidth: 14, textAlign: 'center' },
    promptBtnText: { color: '#fff', fontSize: typography.sizeMd, fontWeight: typography.weightSemibold },
    textOptWrap: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.borderAlt, paddingTop: 10 },
    textOptLabel: { color: colors.textMuted, fontSize: typography.sizeSm, fontWeight: typography.weightSemibold, marginBottom: 6 },
    textOptRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    textOptInput: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 10,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: colors.text,
      fontSize: typography.size,
      borderWidth: 1,
      borderColor: colors.borderAlt,
    },
    textOptBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    textOptBtnOff: { backgroundColor: colors.border },
    textOptBtnText: { color: '#fff', fontSize: 18, fontWeight: typography.weightBold },
    composer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      gap: spacing.sm,
    },
    input: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 20,
      paddingHorizontal: spacing.lg,
      paddingVertical: 10,
      color: colors.text,
      fontSize: typography.sizeLg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    sendBtnOff: { backgroundColor: colors.border },
    sendBtnText: { color: '#fff', fontSize: 18, fontWeight: typography.weightBold, lineHeight: 22 },
    pickerWrap: { maxHeight: 260, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
    pickerList: { flexGrow: 0 },
    pickerRow: {
      paddingHorizontal: spacing.lg,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    pickerLeft: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 2 },
    pickerName: { color: colors.accent, fontSize: typography.size, fontWeight: typography.weightSemibold },
    pickerHint: { color: colors.textMuted, fontSize: typography.sizeSm, fontStyle: 'italic' },
    pickerDesc: { color: colors.textDim, fontSize: typography.sizeSm },
  })
}
