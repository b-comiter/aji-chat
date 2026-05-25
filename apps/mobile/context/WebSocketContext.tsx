/**
 * Shared WebSocket connection + SQLite persistence layer.
 *
 * Mount <WSProvider> once at the root (inside <SQLiteProvider>).
 * Screens call useWS() to get connection state, sendEvent(), and subscribe().
 *
 * Responsibilities:
 *  - Manages WS lifecycle (connect / reconnect with backoff / AppState wakeup)
 *  - Persists incoming events to SQLite (agents + items tables)
 *  - Fans out raw ServerEvents to per-agent subscribers so chat screens can
 *    update their live state without re-querying the database on every delta
 *
 * Each subscriber is keyed by chatId. Pass '*' to receive every event
 * regardless of agent (used by the home screen to update previews/status).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AppState } from 'react-native'
import type { ClientEvent, ServerEvent } from '@aji/protocol'
import { useDB } from '../db/DBProvider'
import {
  deleteItem,
  insertItem,
  updateAgentPreview,
  updateAgentStatus,
  upsertAgent,
} from '../db/database'

const SERVER_WS = `ws://${process.env.EXPO_PUBLIC_SERVER_HOST}:4000/ws`
const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000]

export type ConnStatus = 'connecting' | 'connected' | 'disconnected'

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

interface WSContextValue {
  conn: ConnStatus
  sendEvent: (e: ClientEvent) => void
  /** Subscribe to events for a specific chat (agent id). Pass '*' for all events. */
  subscribe: (chatId: string, handler: (e: ServerEvent) => void) => () => void
}

const WSContext = createContext<WSContextValue>({
  conn: 'connecting',
  sendEvent: () => {},
  subscribe: () => () => {},
})

export function useWS(): WSContextValue {
  return useContext(WSContext)
}

// ---------------------------------------------------------------------------
// In-flight tracking (text accumulation for streaming messages)
// ---------------------------------------------------------------------------

type InFlight = {
  kind: 'message' | 'tool'
  chatId: string
  turnId?: string
  // message-specific
  role?: string
  text?: string
  // tool-specific
  name?: string
  args?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function WSProvider({ children }: { children: ReactNode }) {
  const db = useDB()
  const [conn, setConn] = useState<ConnStatus>('connecting')

  const ws = useRef<WebSocket | null>(null)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)

  // Per-chat subscriber sets. Key '*' = all-events listener.
  const subscribers = useRef<Map<string, Set<(e: ServerEvent) => void>>>(new Map())

  // Tracks in-flight messages/tools so we can accumulate text and write the
  // final payload to SQLite only on message_end / tool_end.
  const inFlight = useRef<Map<string, InFlight>>(new Map())

  // ---------------------------------------------------------------------------
  // Fan-out helpers
  // ---------------------------------------------------------------------------

  function notify(chatId: string, event: ServerEvent) {
    subscribers.current.get(chatId)?.forEach((h) => h(event))
    subscribers.current.get('*')?.forEach((h) => h(event))
  }

  // ---------------------------------------------------------------------------
  // Event handler — persists to SQLite and fans out to subscribers
  // ---------------------------------------------------------------------------

  async function handleEvent(event: ServerEvent): Promise<void> {
    const chatId: string = event.agent ?? 'unknown'
    const turnId: string | undefined =
      'turn_id' in event ? (event.turn_id as string | undefined) : undefined

    try {
      switch (event.type) {
        case 'message_start': {
          inFlight.current.set(event.id, {
            kind: 'message',
            chatId,
            turnId,
            role: event.role,
            text: '',
          })

          upsertAgent(db, chatId).catch((err) =>
            console.warn('[WSContext] upsertAgent error', err),
          )
          break
        }

        case 'text_delta': {
          const inf = inFlight.current.get(event.id)
          if (inf) inf.text = (inf.text ?? '') + event.text
          break
        }

        case 'message_end': {
          const inf = inFlight.current.get(event.id)
          if (inf) {
            inFlight.current.delete(event.id)
            const finalData = {
              kind: 'message' as const,
              id: event.id,
              role: inf.role ?? 'assistant',
              text: inf.text ?? '',
              done: true,
              turnId: inf.turnId,
            }
            // Upsert agent first (FK dependency), then insert the complete row.
            await upsertAgent(db, inf.chatId)
            await insertItem(db, {
              id: event.id,
              chatId: inf.chatId,
              kind: 'message',
              data: finalData,
              turnId: inf.turnId,
            })
            await updateAgentPreview(db, inf.chatId, inf.text ?? '')
          }
          break
        }

        case 'tool_start': {
          // Same pattern as message_start — register inFlight synchronously,
          // no DB write until tool_end delivers the complete result.
          inFlight.current.set(event.id, {
            kind: 'tool',
            chatId,
            turnId,
            name: event.name,
            args: event.args,
          })
          upsertAgent(db, chatId).catch((err) =>
            console.warn('[WSContext] upsertAgent error', err),
          )
          break
        }

        case 'tool_end': {
          const inf = inFlight.current.get(event.id)
          if (inf) {
            inFlight.current.delete(event.id)
            await upsertAgent(db, inf.chatId)
            await insertItem(db, {
              id: event.id,
              chatId: inf.chatId,
              kind: 'tool',
              data: {
                kind: 'tool',
                id: event.id,
                name: inf.name ?? 'unknown',
                args: inf.args ?? {},
                result: event.result,
                done: true,
                turnId: inf.turnId,
              },
              turnId: inf.turnId,
            })
          }
          // If there's no inFlight entry, tool_start was missed entirely — skip.
          break
        }

        case 'permission_request': {
          await upsertAgent(db, chatId)
          await insertItem(db, {
            id: event.id,
            chatId,
            kind: 'prompt',
            data: {
              kind: 'prompt',
              id: event.id,
              title: event.title,
              message: event.message,
              options: event.options,
              turnId,
            },
            turnId,
          })
          break
        }

        case 'clarify': {
          await upsertAgent(db, chatId)
          await insertItem(db, {
            id: event.id,
            chatId,
            kind: 'prompt',
            data: {
              kind: 'prompt',
              id: event.id,
              title: 'Clarification',
              message: event.question,
              options: event.choices,
              turnId,
            },
            turnId,
          })
          break
        }

        case 'prompt_dismiss': {
          await deleteItem(db, event.id)
          break
        }

        case 'status': {
          await updateAgentStatus(db, chatId, event.value)
          break
        }

        default:
          break
      }
    } catch (err) {
      console.warn('[WSContext] DB error handling event', event.type, err)
    }

    // Fan out to subscribers regardless of DB success
    notify(chatId, event)
  }

  // ---------------------------------------------------------------------------
  // WebSocket lifecycle
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function connect() {
      if (!mounted.current) return
      setConn('connecting')
      const socket = new WebSocket(SERVER_WS)
      ws.current = socket

      socket.onopen = () => {
        attempt.current = 0
        setConn('connected')
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
        try {
          const event = JSON.parse(e.data as string) as ServerEvent
          handleEvent(event).catch((err) =>
            console.warn('[WSContext] handleEvent error', err),
          )
        } catch (err) {
          console.warn('[WSContext] parse error', err)
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const sendEvent = useCallback((event: ClientEvent) => {
    ws.current?.send(JSON.stringify(event))
  }, [])

  const subscribe = useCallback(
    (chatId: string, handler: (e: ServerEvent) => void): (() => void) => {
      const set = subscribers.current.get(chatId) ?? new Set()
      set.add(handler)
      subscribers.current.set(chatId, set)
      return () => {
        set.delete(handler)
        if (set.size === 0) subscribers.current.delete(chatId)
      }
    },
    [],
  )

  const value = useMemo(
    () => ({ conn, sendEvent, subscribe }),
    [conn, sendEvent, subscribe],
  )

  return <WSContext.Provider value={value}>{children}</WSContext.Provider>
}
