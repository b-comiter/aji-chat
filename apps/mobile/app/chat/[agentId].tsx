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
import { useEffect, useRef, useState } from 'react'
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
import type { AgentStatus, CommandItem, ServerEvent } from '@aji/protocol'
import { newId } from '@aji/protocol'
import { MarkdownMessage } from '../../components/MarkdownMessage'
import { useWS } from '../../context/WebSocketContext'
import {
  agentDisplayName,
  clearAgentHistory,
  getDbDump,
  getItemsForAgent,
  wipeAllHistory,
  type ItemRow,
} from '../../db/database'

const SERVER_HTTP = `http://${process.env.EXPO_PUBLIC_SERVER_HOST}:4000`

// ---------------------------------------------------------------------------
// Local slash commands — handled client-side, never forwarded to the server
// ---------------------------------------------------------------------------

const LOCAL_COMMANDS: CommandItem[] = [
  { name: 'clear',             description: 'Clear chat history for this agent',              category: 'Dev' },
  { name: 'view-db',           description: 'Dump database contents to server log',           category: 'Dev' },
  { name: 'view-chat-history', description: 'Log this agent\'s chat messages to server console', category: 'Dev', args_hint: '[with-tools]' },
  { name: 'view-last-n-msgs',  description: 'Log the last N messages to server console',      category: 'Dev', args_hint: '<count>' },
  { name: 'wipe-db',           description: 'Wipe ALL history for ALL agents',                category: 'Dev' },
]

// ---------------------------------------------------------------------------
// Local command handler factories
// ---------------------------------------------------------------------------
// These factories are called with necessary closures (db, items, setItems, etc.)
// and return async handler functions for each command.

type CommandHandler = (args: string[]) => Promise<void>

interface LocalCommandHandlers {
  [name: string]: (ctx: {
    agentId?: string
    db: any
    items: Item[]
    setItems: (updater: (prev: Item[]) => Item[]) => void
    addSystemMessage: (text: string) => void
    router: any
  }) => CommandHandler
}

const createLocalCommandHandlers = (): LocalCommandHandlers => ({
  clear: (ctx) => async () => {
    await clearAgentHistory(ctx.db, ctx.agentId ?? 'unknown')
    ctx.setItems(() => [])
    ctx.addSystemMessage('Chat history cleared.')
  },

  ['view-db']: (ctx) => async () => {
    const dump = await getDbDump(ctx.db)
    try {
      await fetch(`${SERVER_HTTP}/db/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dump),
      })
      ctx.addSystemMessage('DB dump sent to server log.')
    } catch {
      ctx.addSystemMessage('Could not reach server — is it running?')
    }
  },

  ['view-chat-history']: (ctx) => async (args: string[]) => {
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
      await fetch(`${SERVER_HTTP}/chat/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: ctx.agentId ?? 'unknown', items: payload }),
      })
      ctx.addSystemMessage(`Chat history sent to server log${withTools ? ' (with tools)' : ''}.`)
    } catch {
      ctx.addSystemMessage('Could not reach server — is it running?')
    }
  },

  ['view-last-n-msgs']: (ctx) => async (args: string[]) => {
    const countStr = args[0] || '10'
    const count = Math.max(1, parseInt(countStr, 10) || 10)
    const messages = ctx.items
      .filter((it): it is Extract<Item, { kind: 'message' }> => it.kind === 'message')
      .slice(-count)
    try {
      await fetch(`${SERVER_HTTP}/last-messages/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: ctx.agentId ?? 'unknown', messages }),
      })
      ctx.addSystemMessage(`Last ${count} message${count !== 1 ? 's' : ''} sent to server log.`)
    } catch {
      ctx.addSystemMessage('Could not reach server — is it running?')
    }
  },

  ['wipe-db']: (ctx) => async () => {
    await wipeAllHistory(ctx.db)
    ctx.setItems(() => [])
    ctx.router.replace('/')
  },
})

// ---------------------------------------------------------------------------
// Item types (in-memory, deserialized from DB JSON blobs)
// ---------------------------------------------------------------------------

type PromptOpt = { id: string; label: string; allowText?: boolean }

type Item =
  | { kind: 'message'; id: string; role: 'assistant' | 'user' | 'system'; text: string; done: boolean; turnId?: string }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; result?: unknown; done: boolean; turnId?: string }
  | { kind: 'prompt'; id: string; title: string; message: string; options: PromptOpt[]; turnId?: string }

function rowToItem(row: ItemRow): Item {
  return JSON.parse(row.data) as Item
}

// ---------------------------------------------------------------------------
// Out-of-order event resilience helper
// ---------------------------------------------------------------------------

/**
 * Ensure a message exists in the items array. If it doesn't exist, create it.
 * Used by message_start, text_delta, and message_end handlers to be defensive
 * against events arriving out of sequence.
 */
function ensureMessageExists(
  items: Item[],
  messageId: string,
  turnId: string | undefined,
  done: boolean = false,
): Item[] {
  const exists = items.some((it) => it.kind === 'message' && it.id === messageId)
  if (exists) return items
  const newItem: Item = {
    kind: 'message',
    id: messageId,
    role: 'assistant',
    text: '',
    done,
    turnId,
  }
  return [...items, newItem]
}

// ---------------------------------------------------------------------------
// Chat screen
// ---------------------------------------------------------------------------

export default function ChatScreen() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>()
  const db = useDB()
  const { conn, sendEvent, subscribe } = useWS()

  const [items, setItems] = useState<Item[]>([])
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle')
  const [draft, setDraft] = useState('')
  const [commands, setCommands] = useState<CommandItem[]>([])

  const listRef = useRef<FlatList>(null)
  const { top: safeTop, bottom: safeBottom } = useSafeAreaInsets()

  const kbOffsetRef = useRef<Animated.Value | null>(null)
  if (!kbOffsetRef.current) kbOffsetRef.current = new Animated.Value(safeBottom)
  const kbOffset = kbOffsetRef.current

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

  // Load history from SQLite on mount
  useEffect(() => {
    if (!agentId) return
    getItemsForAgent(db, agentId).then((rows) => {
      setItems(rows.map(rowToItem))
    })
  }, [db, agentId])

  // Subscribe to live events for this agent
  useEffect(() => {
    if (!agentId) return
    return subscribe(agentId, handleEvent)
  }, [agentId, subscribe])

  // ---------------------------------------------------------------------------
  // Event handler (live events only — history comes from DB)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Event handler — defensively resilient to out-of-order arrivals
  // ---------------------------------------------------------------------------
  // Events may arrive out of sequence due to HTTP request reordering or
  // async scheduling in the adapter. The ensureMessageExists() helper guards
  // against all permutations:
  //   • text_delta before message_start: creates item on the fly
  //   • message_end before message_start: creates done:true placeholder
  //   • message_start after text_delta: skips (item already exists)
  //   • message_start after message_end: skips (item already exists)
  //   • Normal order (start → delta → end): works as expected
  function handleEvent(event: ServerEvent) {
    console.log('Received event:', event)
    const turnId = 'turn_id' in event ? (event.turn_id as string | undefined) : undefined

    setItems((prev) => {
      switch (event.type) {
        case 'message_start': {
          return ensureMessageExists(prev, event.id, turnId, false)
        }

        case 'text_delta': {
          let updated = ensureMessageExists(prev, event.id, turnId, false)
          return updated.map((it) =>
            it.kind === 'message' && it.id === event.id
              ? { ...it, text: it.text + event.text }
              : it,
          )
        }

        case 'message_end': {
          return ensureMessageExists(prev, event.id, turnId, true)
        }

        case 'tool_start':
          return [...prev, { kind: 'tool', id: event.id, name: event.name, args: event.args, done: false, turnId }]

        case 'tool_end':
          return prev.map((it) =>
            it.kind === 'tool' && it.id === event.id
              ? { ...it, result: event.result, done: true }
              : it,
          )

        case 'permission_request':
          return [...prev, { kind: 'prompt', id: event.id, title: event.title, message: event.message, options: event.options, turnId }]

        case 'clarify':
          return [...prev, { kind: 'prompt', id: event.id, title: 'Clarification', message: event.question, options: event.choices, turnId }]

        case 'prompt_dismiss':
          return prev.filter((it) => !(it.kind === 'prompt' && it.id === event.id))

        default:
          return prev
      }
    })

    if (event.type === 'status') setAgentStatus(event.value)
    if (event.type === 'commands') setCommands(event.commands)
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  function respond(promptId: string, choice: string) {
    sendEvent({ type: 'prompt_response', id: promptId, choice })
    setItems((prev) => prev.filter((it) => !(it.kind === 'prompt' && it.id === promptId)))
  }

  // ---------------------------------------------------------------------------
  // Local command handlers (initialized with current context)
  // ---------------------------------------------------------------------------

  const addSystemMessage = (text: string) => {
    setItems((prev) => [
      ...prev,
      { kind: 'message', id: newId('sys'), role: 'system', text, done: true },
    ])
  }

  const handleLocalCommand = async (cmd: string, args: string[] = []): Promise<boolean> => {
    const handlers = createLocalCommandHandlers()
    const handler = handlers[cmd]
    if (!handler) return false

    const context = {
      agentId,
      db,
      items,
      setItems,
      addSystemMessage,
      router,
    }
    try {
      await handler(context)(args)
      return true
    } catch (err) {
      console.error(`Command /${cmd} failed:`, err)
      addSystemMessage(`Error running /${cmd}: ${err instanceof Error ? err.message : 'unknown error'}`)
      return true
    }
  }

  function sendMessage() {
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
    setItems((prev) => [...prev, { kind: 'message', id: newId('msg'), role: 'user', text, done: true }])
    sendEvent({ type: 'user_message', text })
    setDraft('')
  }

  // ---------------------------------------------------------------------------
  // Command picker — local commands shown first, then server commands
  // ---------------------------------------------------------------------------

  const rawQuery = draft.startsWith('/') ? draft.slice(1) : null
  const pickerQuery = rawQuery !== null && !rawQuery.includes(' ') ? rawQuery.toLowerCase() : null
  const allCommands = [...LOCAL_COMMANDS, ...commands]
  const pickerItems = pickerQuery !== null
    ? allCommands
        .filter((c) =>
          c.name.startsWith(pickerQuery) ||
          (c.aliases ?? []).some((a) => a.startsWith(pickerQuery)),
        )
        .slice(0, 20)
    : []
  const showPicker = pickerItems.length > 0

  const connColor =
    conn === 'connected' ? '#3fb950' : conn === 'connecting' ? '#d29922' : '#f85149'
  const canSend = draft.trim().length > 0 && conn === 'connected'
  const displayName = agentId ? agentDisplayName(agentId) : 'Chat'

  return (
    <Animated.View style={[styles.screen, { paddingTop: safeTop + 12, paddingBottom: kbOffset }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{displayName}</Text>
        {agentStatus !== 'idle' && (
          <Text style={styles.agentStatus}>{agentStatus}…</Text>
        )}
        <View style={[styles.dot, { backgroundColor: connColor }]} />
      </View>

      {/* Message list */}
      {items.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.empty}>No messages yet</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(it) => `${it.kind}-${it.id}`}
          renderItem={({ item }) => <Row item={item} onChoose={respond} />}
          contentContainerStyle={styles.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        />
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
          placeholderTextColor="#6e7681"
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
// Sub-components (PromptRow, CommandPicker, Row) — unchanged from original
// ---------------------------------------------------------------------------

function PromptRow({
  item,
  onChoose,
}: {
  item: Extract<Item, { kind: 'prompt' }>
  onChoose: (id: string, choice: string) => void
}) {
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
              placeholderTextColor="#6e7681"
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

function Row({
  item,
  onChoose,
}: {
  item: Item
  onChoose: (id: string, choice: string) => void
}) {
  const inTurn = !!item.turnId

  if (item.kind === 'message') {
    const isUser = item.role === 'user'
    return (
      <View style={[styles.bubbleRow, isUser && styles.bubbleRowUser, inTurn && !isUser && styles.turnRail]}>
        <View style={[styles.bubble, isUser && styles.bubbleUser]}>
          {isUser || !item.done ? (
            <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
              {item.text}{!item.done && <Text style={styles.cursor}> ▍</Text>}
            </Text>
          ) : (
            <MarkdownMessage content={item.text} />
          )}
        </View>
      </View>
    )
  }

  if (item.kind === 'tool') {
    return (
      <View style={[styles.toolCard, inTurn && styles.turnRail]}>
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

  return (
    <View style={inTurn ? styles.turnRail : undefined}>
      <PromptRow item={item} onChoose={onChoose} />
    </View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0d1117' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
    gap: 8,
  },
  backBtn: { paddingRight: 4 },
  backText: { color: '#5e8eff', fontSize: 28, lineHeight: 32 },
  title: { color: '#e6edf3', fontSize: 17, fontWeight: '600', flex: 1 },
  agentStatus: { color: '#b392f0', fontSize: 13, fontStyle: 'italic' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  emptyWrap: { flex: 1, justifyContent: 'center' },
  empty: { color: '#6e7681', textAlign: 'center', fontSize: 15 },
  list: { padding: 16, gap: 10 },
  turnRail: { borderLeftWidth: 2, borderLeftColor: 'rgba(94, 142, 255, 0.3)', paddingLeft: 10 },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubble: {
    backgroundColor: '#161b22',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#21262d',
  },
  bubbleUser: { backgroundColor: '#5e8eff', borderColor: '#5e8eff', maxWidth: '80%' },
  bubbleText: { color: '#e6edf3', fontSize: 15, lineHeight: 22 },
  bubbleTextUser: { color: '#fff' },
  cursor: { color: '#5e8eff' },
  toolCard: {
    backgroundColor: '#1c2129',
    borderRadius: 12,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#b392f0',
  },
  toolLabel: { color: '#b392f0', fontSize: 13, fontWeight: '600', marginBottom: 4 },
  toolMono: { color: '#8b949e', fontSize: 12, fontFamily: 'Menlo', marginTop: 2 },
  promptCard: {
    backgroundColor: '#242b35',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#d29922',
  },
  promptTitle: { color: '#e6edf3', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  promptMsg: { color: '#8b949e', fontSize: 14, marginBottom: 12 },
  promptBtns: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  promptBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#5e8eff',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  promptBtnNum: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '700', minWidth: 14, textAlign: 'center' },
  promptBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  textOptWrap: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#3a424d', paddingTop: 10 },
  textOptLabel: { color: '#8b949e', fontSize: 12, fontWeight: '600', marginBottom: 6 },
  textOptRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  textOptInput: {
    flex: 1,
    backgroundColor: '#161b22',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#e6edf3',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#3a424d',
  },
  textOptBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#5e8eff', alignItems: 'center', justifyContent: 'center' },
  textOptBtnOff: { backgroundColor: '#21262d' },
  textOptBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#161b22',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#e6edf3',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#21262d',
  },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#5e8eff', alignItems: 'center', justifyContent: 'center' },
  sendBtnOff: { backgroundColor: '#21262d' },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '700', lineHeight: 22 },
  pickerWrap: { maxHeight: 260, borderTopWidth: 1, borderTopColor: '#21262d', backgroundColor: '#161b22' },
  pickerList: { flexGrow: 0 },
  pickerRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#21262d',
  },
  pickerLeft: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 2 },
  pickerName: { color: '#5e8eff', fontSize: 14, fontWeight: '600' },
  pickerHint: { color: '#8b949e', fontSize: 12, fontStyle: 'italic' },
  pickerDesc: { color: '#6e7681', fontSize: 12 },
})
