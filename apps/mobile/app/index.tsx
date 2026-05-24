import { useEffect, useRef, useState } from 'react'
import {
  Animated,
  AppState,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { AgentStatus, CommandItem, ServerEvent } from '@aji/protocol'
import { MarkdownMessage } from '../components/MarkdownMessage'
import { newId } from '@aji/protocol'

const SERVER_WS = `ws://${process.env.EXPO_PUBLIC_SERVER_HOST}:4000/ws`

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000]

type ConnStatus = 'connecting' | 'connected' | 'disconnected'

type PromptOpt = { id: string; label: string; allowText?: boolean }

type Item =
  | { kind: 'message'; id: string; role: 'assistant' | 'user' | 'system'; text: string; done: boolean; turnId?: string }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; result?: unknown; done: boolean; turnId?: string }
  | { kind: 'prompt'; id: string; title: string; message: string; options: PromptOpt[]; turnId?: string }

export default function ChatScreen() {
  const [items, setItems] = useState<Item[]>([])
  const [conn, setConn] = useState<ConnStatus>('connecting')
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle')
  const [draft, setDraft] = useState('')
  const [commands, setCommands] = useState<CommandItem[]>([])
  const ws = useRef<WebSocket | null>(null)
  const listRef = useRef<FlatList>(null)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)

  const { top: safeTop, bottom: safeBottom } = useSafeAreaInsets()

  // kbOffset drives paddingBottom on the root view.
  // At rest it equals safeBottom so the composer clears the home indicator.
  // When the keyboard opens it animates to endCoordinates.height (keyboard + home indicator area).
  const kbOffsetRef = useRef<Animated.Value | null>(null)
  if (!kbOffsetRef.current) kbOffsetRef.current = new Animated.Value(safeBottom)
  const kbOffset = kbOffsetRef.current

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

  // WebSocket with exponential backoff and AppState reconnect
  useEffect(() => {
    function connect() {
      if (!mounted.current) return
      setConn('connecting')
      const socket = new WebSocket(SERVER_WS)
      ws.current = socket

      socket.onopen = () => {
        attempt.current = 0
        setConn('connected')
        // Request the slash command list. The plugin responds with a `commands`
        // event (broadcast to all WebSocket clients). This handles the case
        // where mobile connects after the plugin is already running; the plugin
        // also pushes the list proactively on its first successful registration,
        // so whichever fires second wins (both are idempotent).
        socket.send(JSON.stringify({ type: 'get_commands' }))
      }
      socket.onerror = () => socket.close()
      socket.onclose = () => {
        if (!mounted.current) return
        setConn('disconnected')
        const delay = BACKOFF[Math.min(attempt.current, BACKOFF.length - 1)]
        attempt.current += 1
        timer.current = setTimeout(connect, delay)
      }
      socket.onmessage = (e) => {
        try { handleEvent(JSON.parse(e.data as string) as ServerEvent) }
        catch (err) { console.warn('parse error', err) }
      }
    }

    connect()

    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        const s = ws.current?.readyState
        if (s === WebSocket.CLOSED || s === WebSocket.CLOSING) {
          if (timer.current) clearTimeout(timer.current)
          attempt.current = 0
          connect()
        }
      }
    })

    return () => {
      mounted.current = false
      appState.remove()
      if (timer.current) clearTimeout(timer.current)
      ws.current?.close()
    }
  }, [])

  function handleEvent(event: ServerEvent) {
    setItems((prev) => {
      // turn_id is only present on the seven event types that opt in to it.
      // We pull it once here so the switch arms can stamp it on new items.
      const turnId = 'turn_id' in event ? event.turn_id : undefined
      switch (event.type) {
        case 'message_start':
          return [...prev, { kind: 'message', id: event.id, role: event.role, text: '', done: false, turnId }]
        case 'text_delta':
          return prev.map((it) =>
            it.kind === 'message' && it.id === event.id ? { ...it, text: it.text + event.text } : it)
        case 'message_end':
          return prev.map((it) =>
            it.kind === 'message' && it.id === event.id ? { ...it, done: true } : it)
        case 'tool_start':
          return [...prev, { kind: 'tool', id: event.id, name: event.name, args: event.args, done: false, turnId }]
        case 'tool_end':
          return prev.map((it) =>
            it.kind === 'tool' && it.id === event.id ? { ...it, result: event.result, done: true } : it)
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

  function respond(promptId: string, choice: string) {
    ws.current?.send(JSON.stringify({ type: 'prompt_response', id: promptId, choice }))
    setItems((prev) => prev.filter((it) => !(it.kind === 'prompt' && it.id === promptId)))
  }

  function sendMessage() {
    const text = draft.trim()
    if (!text || ws.current?.readyState !== WebSocket.OPEN) return
    setItems((prev) => [...prev, { kind: 'message', id: newId('msg'), role: 'user', text, done: true }])
    ws.current.send(JSON.stringify({ type: 'user_message', text }))
    setDraft('')
  }

  const connColor = conn === 'connected' ? '#3fb950' : conn === 'connecting' ? '#d29922' : '#f85149'
  const canSend = draft.trim().length > 0 && conn === 'connected'

  // Slash command picker — visible while the user is typing the command name
  // (after "/" and before any space). Hides once they start typing arguments.
  const rawQuery = draft.startsWith('/') ? draft.slice(1) : null
  const pickerQuery = rawQuery !== null && !rawQuery.includes(' ') ? rawQuery.toLowerCase() : null
  const pickerItems = pickerQuery !== null
    ? commands
        .filter((c) =>
          c.name.startsWith(pickerQuery) ||
          (c.aliases ?? []).some((a) => a.startsWith(pickerQuery))
        )
        .slice(0, 20)
    : []
  const showPicker = pickerItems.length > 0

  function selectCommand(name: string) {
    setDraft(`/${name} `)
  }

  return (
    <Animated.View style={[styles.screen, { paddingTop: safeTop + 12, paddingBottom: kbOffset }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>aji-chat</Text>
        {agentStatus !== 'idle' && <Text style={styles.agentStatus}>{agentStatus}…</Text>}
        <View style={[styles.dot, { backgroundColor: connColor }]} />
        <Text style={[styles.connStatus, { color: connColor }]}>{conn}</Text>
      </View>

      {/* Message list */}
      {items.length === 0
        ? <View style={styles.emptyWrap}><Text style={styles.empty}>waiting for messages…</Text></View>
        : <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(it) => `${it.kind}-${it.id}`}
            renderItem={({ item }) => <Row item={item} onChoose={respond} />}
            contentContainerStyle={styles.list}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          />
      }

      {/* Slash command picker */}
      {showPicker && (
        <CommandPicker items={pickerItems} onSelect={selectCommand} />
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
        <Pressable style={[styles.sendBtn, !canSend && styles.sendBtnOff]} onPress={sendMessage} disabled={!canSend}>
          <Text style={styles.sendBtnText}>↑</Text>
        </Pressable>
      </View>
    </Animated.View>
  )
}

function PromptRow({ item, onChoose }: { item: Extract<Item, { kind: 'prompt' }>; onChoose: (id: string, choice: string) => void }) {
  const [textValues, setTextValues] = useState<Record<string, string>>({})

  const buttonOpts = item.options.filter(o => !o.allowText)
  const textOpts   = item.options.filter(o => o.allowText)

  return (
    <View style={styles.promptCard}>
      <Text style={styles.promptTitle}>{item.title}</Text>
      <Text style={styles.promptMsg}>{item.message}</Text>

      {/* Button options */}
      {buttonOpts.length > 0 && (
        <View style={styles.promptBtns}>
          {buttonOpts.map((opt, i) => (
            <Pressable key={opt.id} style={styles.promptBtn} onPress={() => onChoose(item.id, opt.id)}>
              <Text style={styles.promptBtnNum}>{i + 1}</Text>
              <Text style={styles.promptBtnText}>{opt.label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Text input options */}
      {textOpts.map((opt) => (
        <View key={opt.id} style={styles.textOptWrap}>
          <Text style={styles.textOptLabel}>{opt.label}</Text>
          <View style={styles.textOptRow}>
            <TextInput
              style={styles.textOptInput}
              value={textValues[opt.id] ?? ''}
              onChangeText={(v) => setTextValues(prev => ({ ...prev, [opt.id]: v }))}
              placeholder="Type your answer…"
              placeholderTextColor="#6e7681"
              returnKeyType="send"
              onSubmitEditing={() => {
                const val = (textValues[opt.id] ?? '').trim()
                if (val) onChoose(item.id, val)
              }}
            />
            <Pressable
              style={[styles.textOptBtn, !(textValues[opt.id] ?? '').trim() && styles.textOptBtnOff]}
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
        // Keep the keyboard open when the user taps a suggestion.
        keyboardShouldPersistTaps="always"
        style={styles.pickerList}
        renderItem={({ item: cmd, index }) => (
          <Pressable
            style={[styles.pickerRow, index === 0 && styles.pickerRowFirst]}
            onPress={() => onSelect(cmd.name)}
          >
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

function Row({ item, onChoose }: { item: Item; onChoose: (id: string, choice: string) => void }) {
  // Items emitted as part of a Hermes turn carry `turnId`. We render them with
  // a subtle left rail so the user can visually see "this tool / this message
  // / this prompt was part of the same conversation turn." Items without
  // `turnId` (Claude Code path, user bubbles) render unchanged.
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
          <Text style={styles.toolMono}>{typeof item.result === 'string' ? item.result : JSON.stringify(item.result)}</Text>
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0d1117' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: '#21262d', gap: 8,
  },
  title: { color: '#e6edf3', fontSize: 18, fontWeight: '600', flex: 1 },
  agentStatus: { color: '#b392f0', fontSize: 13, fontStyle: 'italic' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  connStatus: { fontSize: 13 },
  emptyWrap: { flex: 1, justifyContent: 'center' },
  empty: { color: '#6e7681', textAlign: 'center', fontSize: 15 },
  list: { padding: 16, gap: 10 },
  // Turn rail — subtle left border when an item belongs to a Hermes turn.
  // 30%-opacity accent colour so it reads as grouping, not chrome.
  turnRail: { borderLeftWidth: 2, borderLeftColor: 'rgba(94, 142, 255, 0.3)', paddingLeft: 10 },
  // Bubbles
  bubbleRow: { flexDirection: 'row' },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubble: {
    backgroundColor: '#161b22', borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 12,
    borderWidth: 1, borderColor: '#21262d',
  },
  bubbleUser: { backgroundColor: '#5e8eff', borderColor: '#5e8eff', maxWidth: '80%' },
  bubbleText: { color: '#e6edf3', fontSize: 15, lineHeight: 22 },
  bubbleTextUser: { color: '#fff' },
  cursor: { color: '#5e8eff' },
  // Tool card
  toolCard: {
    backgroundColor: '#1c2129', borderRadius: 12, padding: 12,
    borderLeftWidth: 3, borderLeftColor: '#b392f0',
  },
  toolLabel: { color: '#b392f0', fontSize: 13, fontWeight: '600', marginBottom: 4 },
  toolMono: { color: '#8b949e', fontSize: 12, fontFamily: 'Menlo', marginTop: 2 },
  // Prompt card
  promptCard: {
    backgroundColor: '#242b35', borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: '#d29922',
  },
  promptTitle: { color: '#e6edf3', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  promptMsg: { color: '#8b949e', fontSize: 14, marginBottom: 12 },
  promptBtns: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  promptBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#5e8eff', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  promptBtnNum: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '700', minWidth: 14, textAlign: 'center' },
  promptBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  // text-input option
  textOptWrap: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#3a424d', paddingTop: 10 },
  textOptLabel: { color: '#8b949e', fontSize: 12, fontWeight: '600', marginBottom: 6 },
  textOptRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  textOptInput: {
    flex: 1, backgroundColor: '#161b22', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 8,
    color: '#e6edf3', fontSize: 14, borderWidth: 1, borderColor: '#3a424d',
  },
  textOptBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#5e8eff', alignItems: 'center', justifyContent: 'center' },
  textOptBtnOff: { backgroundColor: '#21262d' },
  textOptBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  // Composer
  composer: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: '#21262d', gap: 8,
  },
  input: {
    flex: 1, backgroundColor: '#161b22', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10,
    color: '#e6edf3', fontSize: 15, borderWidth: 1, borderColor: '#21262d',
  },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#5e8eff', alignItems: 'center', justifyContent: 'center' },
  sendBtnOff: { backgroundColor: '#21262d' },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '700', lineHeight: 22 },
  // Slash command picker
  pickerWrap: {
    maxHeight: 260,
    borderTopWidth: 1, borderTopColor: '#21262d',
    backgroundColor: '#161b22',
  },
  pickerList: { flexGrow: 0 },
  pickerRow: {
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#21262d',
  },
  pickerRowFirst: {},
  pickerLeft: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 2 },
  pickerName: { color: '#5e8eff', fontSize: 14, fontWeight: '600' },
  pickerHint: { color: '#8b949e', fontSize: 12, fontStyle: 'italic' },
  pickerDesc: { color: '#6e7681', fontSize: 12 },
})
