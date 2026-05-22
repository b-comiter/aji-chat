import { useEffect, useRef, useState } from 'react'
import {
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import type { AgentStatus, ServerEvent } from '@aji/protocol'

// Set EXPO_PUBLIC_SERVER_HOST in apps/mobile/.env to your Mac's LAN IP.
// Find it with: ipconfig getifaddr en0
const SERVER_WS = `ws://${process.env.EXPO_PUBLIC_SERVER_HOST}:4000/ws`

type ConnStatus = 'connecting' | 'connected' | 'disconnected'

type Item =
  | { kind: 'message'; id: string; role: 'assistant' | 'user' | 'system'; text: string; done: boolean }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; result?: unknown; done: boolean }
  | { kind: 'prompt'; id: string; title: string; message: string; options: { id: string; label: string }[] }

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000]

export default function HomeScreen() {
  const [items, setItems] = useState<Item[]>([])
  const [conn, setConn] = useState<ConnStatus>('connecting')
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle')
  const ws = useRef<WebSocket | null>(null)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)

  function handleEvent(event: ServerEvent) {
    setItems((prev) => {
      switch (event.type) {
        case 'message_start':
          return [
            { kind: 'message', id: event.id, role: event.role, text: '', done: false },
            ...prev,
          ]
        case 'text_delta':
          return prev.map((it) =>
            it.kind === 'message' && it.id === event.id
              ? { ...it, text: it.text + event.text }
              : it,
          )
        case 'message_end':
          return prev.map((it) =>
            it.kind === 'message' && it.id === event.id ? { ...it, done: true } : it,
          )
        case 'tool_start':
          return [
            { kind: 'tool', id: event.id, name: event.name, args: event.args, done: false },
            ...prev,
          ]
        case 'tool_end':
          return prev.map((it) =>
            it.kind === 'tool' && it.id === event.id
              ? { ...it, result: event.result, done: true }
              : it,
          )
        case 'permission_request':
          return [
            {
              kind: 'prompt',
              id: event.id,
              title: event.title,
              message: event.message,
              options: event.options,
            },
            ...prev,
          ]
        case 'clarify':
          return [
            {
              kind: 'prompt',
              id: event.id,
              title: 'Clarification',
              message: event.question,
              options: event.choices,
            },
            ...prev,
          ]
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

  useEffect(() => {
    function connect() {
      if (!mounted.current) return
      setConn('connecting')
      const socket = new WebSocket(SERVER_WS)
      ws.current = socket

      socket.onopen = () => {
        attempt.current = 0
        setConn('connected')
      }

      socket.onmessage = (e) => {
        try {
          handleEvent(JSON.parse(e.data as string) as ServerEvent)
        } catch (err) {
          console.warn('failed to parse event', err)
        }
      }

      socket.onclose = () => {
        if (!mounted.current) return
        setConn('disconnected')
        const delay = BACKOFF[Math.min(attempt.current, BACKOFF.length - 1)]
        attempt.current += 1
        timer.current = setTimeout(connect, delay)
      }

      socket.onerror = () => socket.close()
    }

    connect()

    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        const state = ws.current?.readyState
        if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
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

  const connColor =
    conn === 'connected' ? '#3fb950' : conn === 'connecting' ? '#d29922' : '#f85149'

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>aji-chat</Text>
        {agentStatus !== 'idle' && (
          <Text style={styles.agentStatus}>{agentStatus}…</Text>
        )}
        <View style={[styles.dot, { backgroundColor: connColor }]} />
        <Text style={[styles.connStatus, { color: connColor }]}>{conn}</Text>
      </View>

      {items.length === 0 ? (
        <Text style={styles.empty}>waiting for messages…</Text>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => `${it.kind}-${it.id}`}
          renderItem={({ item }) => <Row item={item} onChoose={respond} />}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  )
}

function Row({ item, onChoose }: { item: Item; onChoose: (id: string, choice: string) => void }) {
  if (item.kind === 'message') {
    return (
      <View style={styles.bubble}>
        <Text style={styles.bubbleText}>
          {item.text}
          {!item.done && <Text style={styles.cursor}> ▍</Text>}
        </Text>
      </View>
    )
  }

  if (item.kind === 'tool') {
    return (
      <View style={styles.toolCard}>
        <Text style={styles.toolLabel}>
          🔧 {item.name} {item.done ? '✓' : '…'}
        </Text>
        <Text style={styles.toolArgs}>{JSON.stringify(item.args)}</Text>
        {item.done && (
          <Text style={styles.toolResult}>
            {typeof item.result === 'string' ? item.result : JSON.stringify(item.result)}
          </Text>
        )}
      </View>
    )
  }

  // prompt
  return (
    <View style={styles.promptCard}>
      <Text style={styles.promptTitle}>{item.title}</Text>
      <Text style={styles.promptMessage}>{item.message}</Text>
      <View style={styles.promptButtons}>
        {item.options.map((opt) => (
          <Pressable
            key={opt.id}
            style={styles.promptButton}
            onPress={() => onChoose(item.id, opt.id)}
          >
            <Text style={styles.promptButtonText}>{opt.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d1117', paddingTop: 60 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
    gap: 8,
  },
  title: { color: '#e6edf3', fontSize: 18, fontWeight: '600', flex: 1 },
  agentStatus: { color: '#b392f0', fontSize: 13, fontStyle: 'italic' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  connStatus: { fontSize: 13 },
  empty: { color: '#6e7681', textAlign: 'center', marginTop: 60, fontSize: 15 },
  list: { padding: 16, gap: 10 },
  bubble: {
    backgroundColor: '#161b22',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#21262d',
  },
  bubbleText: { color: '#e6edf3', fontSize: 15, lineHeight: 22 },
  cursor: { color: '#5e8eff' },
  toolCard: {
    backgroundColor: '#1c2129',
    borderRadius: 12,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#b392f0',
  },
  toolLabel: { color: '#b392f0', fontSize: 13, fontWeight: '600', marginBottom: 4 },
  toolArgs: { color: '#8b949e', fontSize: 12, fontFamily: 'Menlo' },
  toolResult: { color: '#e6edf3', fontSize: 12, fontFamily: 'Menlo', marginTop: 6 },
  promptCard: {
    backgroundColor: '#242b35',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#d29922',
  },
  promptTitle: { color: '#e6edf3', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  promptMessage: { color: '#8b949e', fontSize: 14, marginBottom: 12 },
  promptButtons: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  promptButton: {
    backgroundColor: '#5e8eff',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  promptButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
})
