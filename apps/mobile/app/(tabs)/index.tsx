import { useEffect, useRef, useState } from 'react'
import { AppState, FlatList, StyleSheet, Text, View } from 'react-native'

// Set EXPO_PUBLIC_SERVER_HOST in apps/mobile/.env to your Mac's LAN IP.
// Find it with: ipconfig getifaddr en0
const SERVER_WS = `ws://${process.env.EXPO_PUBLIC_SERVER_HOST}:4000/ws`

type Status = 'connecting' | 'connected' | 'disconnected'

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000]

export default function HomeScreen() {
  const [messages, setMessages] = useState<string[]>([])
  const [status, setStatus] = useState<Status>('connecting')
  const ws = useRef<WebSocket | null>(null)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    function connect() {
      if (!mounted.current) return
      setStatus('connecting')
      const socket = new WebSocket(SERVER_WS)
      ws.current = socket

      socket.onopen = () => {
        attempt.current = 0
        setStatus('connected')
      }

      socket.onmessage = (e) => {
        try {
          const { message } = JSON.parse(e.data as string)
          setMessages((prev) => [message, ...prev])
        } catch {
          setMessages((prev) => [e.data as string, ...prev])
        }
      }

      socket.onclose = () => {
        if (!mounted.current) return
        setStatus('disconnected')
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

  const statusColor =
    status === 'connected' ? '#3fb950' : status === 'connecting' ? '#d29922' : '#f85149'

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>aji-chat</Text>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        <Text style={[styles.status, { color: statusColor }]}>{status}</Text>
      </View>

      {messages.length === 0 ? (
        <Text style={styles.empty}>waiting for messages…</Text>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => (
            <View style={styles.bubble}>
              <Text style={styles.bubbleText}>{item}</Text>
            </View>
          )}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1117',
    paddingTop: 60,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
    gap: 8,
  },
  title: {
    color: '#e6edf3',
    fontSize: 18,
    fontWeight: '600',
    flex: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  status: {
    fontSize: 13,
  },
  empty: {
    color: '#6e7681',
    textAlign: 'center',
    marginTop: 60,
    fontSize: 15,
  },
  list: {
    padding: 16,
    gap: 10,
  },
  bubble: {
    backgroundColor: '#161b22',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#21262d',
  },
  bubbleText: {
    color: '#e6edf3',
    fontSize: 15,
  },
})
