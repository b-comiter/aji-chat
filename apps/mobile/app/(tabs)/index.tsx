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
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs'
import type { AgentStatus, ServerEvent } from '@aji/protocol'
import { newId } from '@aji/protocol'

const SERVER_WS = `ws://${process.env.EXPO_PUBLIC_SERVER_HOST}:4000/ws`

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000]

type ConnStatus = 'connecting' | 'connected' | 'disconnected'

type Item =
  | { kind: 'message'; id: string; role: 'assistant' | 'user' | 'system'; text: string; done: boolean }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; result?: unknown; done: boolean }
  | { kind: 'prompt'; id: string; title: string; message: string; options: { id: string; label: string }[] }

export default function HomeScreen() {
  const [items, setItems] = useState<Item[]>([])
  const [conn, setConn] = useState<ConnStatus>('connecting')
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle')
  const [draft, setDraft] = useState('')
  const ws = useRef<WebSocket | null>(null)
  const listRef = useRef<FlatList>(null)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  const tabBarHeight = useBottomTabBarHeight()
  const kbOffset = useRef(new Animated.Value(0)).current

  // Keyboard animation
  useEffect(() => {
    if (Platform.OS !== 'ios') return
    const onShow = Keyboard.addListener('keyboardWillShow', (e) => {
      Animated.timing(kbOffset, {
        toValue: Math.max(0, e.endCoordinates.height - tabBarHeight),
        duration: e.duration,
        useNativeDriver: false,
      }).start()
    })
    const onHide = Keyboard.addListener('keyboardWillHide', (e) => {
      Animated.timing(kbOffset, { toValue: 0, duration: e.duration, useNativeDriver: false }).start()
    })
    return () => { onShow.remove(); onHide.remove() }
  }, [kbOffset, tabBarHeight])

  // WebSocket
  useEffect(() => {
    function connect() {
      if (!mounted.current) return
      setConn('connecting')
      const socket = new WebSocket(SERVER_WS)
      ws.current = socket

      socket.onopen = () => { attempt.current = 0; setConn('connected') }
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
      switch (event.type) {
        case 'message_start':
          return [...prev, { kind: 'message', id: event.id, role: event.role, text: '', done: false }]
        case 'text_delta':
          return prev.map((it) =>
            it.kind === 'message' && it.id === event.id ? { ...it, text: it.text + event.text } : it)
        case 'message_end':
          return prev.map((it) =>
            it.kind === 'message' && it.id === event.id ? { ...it, done: true } : it)
        case 'tool_start':
          return [...prev, { kind: 'tool', id: event.id, name: event.name, args: event.args, done: false }]
        case 'tool_end':
          return prev.map((it) =>
            it.kind === 'tool' && it.id === event.id ? { ...it, result: event.result, done: true } : it)
        case 'permission_request':
          return [...prev, { kind: 'prompt', id: event.id, title: event.title, message: event.message, options: event.options }]
        case 'clarify':
          return [...prev, { kind: 'prompt', id: event.id, title: 'Clarification', message: event.question, options: event.choices }]
        case 'prompt_dismiss':
          return prev.filter((it) => !(it.kind === 'prompt' && it.id === event.id))
        default:
          return prev
      }
    })
    if (event.type === 'status') setAgentStatus(event.value)
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

  return (
    <Animated.View style={[styles.screen, { paddingBottom: kbOffset }]}>
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

function Row({ item, onChoose }: { item: Item; onChoose: (id: string, choice: string) => void }) {
  if (item.kind === 'message') {
    const isUser = item.role === 'user'
    return (
      <View style={[styles.bubbleRow, isUser && styles.bubbleRowUser]}>
        <View style={[styles.bubble, isUser && styles.bubbleUser]}>
          <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
            {item.text}{!item.done && <Text style={styles.cursor}> ▍</Text>}
          </Text>
        </View>
      </View>
    )
  }

  if (item.kind === 'tool') {
    return (
      <View style={styles.toolCard}>
        <Text style={styles.toolLabel}>🔧 {item.name} {item.done ? '✓' : '…'}</Text>
        <Text style={styles.toolMono}>{JSON.stringify(item.args)}</Text>
        {item.done && item.result !== undefined && (
          <Text style={styles.toolMono}>{typeof item.result === 'string' ? item.result : JSON.stringify(item.result)}</Text>
        )}
      </View>
    )
  }

  return (
    <View style={styles.promptCard}>
      <Text style={styles.promptTitle}>{item.title}</Text>
      <Text style={styles.promptMsg}>{item.message}</Text>
      <View style={styles.promptBtns}>
        {item.options.map((opt) => (
          <Pressable key={opt.id} style={styles.promptBtn} onPress={() => onChoose(item.id, opt.id)}>
            <Text style={styles.promptBtnText}>{opt.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0d1117', paddingTop: 60 },
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
  // Bubbles
  bubbleRow: { flexDirection: 'row' },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubble: {
    backgroundColor: '#161b22', borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 12,
    borderWidth: 1, borderColor: '#21262d', maxWidth: '80%',
  },
  bubbleUser: { backgroundColor: '#5e8eff', borderColor: '#5e8eff' },
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
  promptBtn: { backgroundColor: '#5e8eff', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  promptBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
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
})
