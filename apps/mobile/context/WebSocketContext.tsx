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
  getItemById,
  getSetting,
  persistItem,
  saveCachedCommands,
  setSetting,
  updateServerStatus,
  upsertServer,
  applyServerInfo,
  updateChannelStatus,
  upsertChannel,
  getServer,
  isServerMuted,
  DEFAULT_CHANNEL,
} from '../db/database'
import { convKey } from '../db/convKey'
import { filePreviewLabel } from '../components/chat/fileHelpers'
import { SERVER_CONFIG } from '../constants/server'
import { useMessageSound } from '../hooks/useMessageSound'
import { syncAppBadge } from '../utils/badge'

const SERVER_WS = SERVER_CONFIG.wsEndpoint
const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000]

export type ConnStatus = 'connecting' | 'connected' | 'disconnected'

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

interface WSContextValue {
  conn: ConnStatus
  sendEvent: (e: ClientEvent) => void
  /**
   * Subscribe to events for a specific conversation. The key is a `convKey`
   * (`server/channel`, see db/convKey.ts). Pass '*' to receive every event
   * regardless of conversation (used by the server list and channel list).
   */
  subscribe: (key: string, handler: (e: ServerEvent) => void) => () => void
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
  serverId: string
  channel: string
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

  // New-message chime. Fired here (the one central event sink) so it plays for
  // any incoming message regardless of which screen is open — the chat list, a
  // server's channel list, or the chat itself. Held in a ref because the socket
  // handlers are wired once in a mount-time effect and would otherwise capture a
  // stale closure.
  const playMessageSound = useMessageSound()
  const playMessageSoundRef = useRef(playMessageSound)
  playMessageSoundRef.current = playMessageSound

  const ws = useRef<WebSocket | null>(null)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seqFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  const lastSeqRef = useRef(0)

  // Seqs already processed on the *current* WS connection. The offline-replay
  // path (get_missed_events) can redeliver an event that also arrived live;
  // without this guard a redelivered append-only text_delta would double the
  // rendered + persisted text. Reset on each (re)connect so a restarted server —
  // whose seq counter starts back at 0 — isn't wrongly filtered out.
  const seenSeqs = useRef<Set<number>>(new Set())

  // Per-conversation subscriber sets, keyed by convKey. Key '*' = all-events
  // listener (server list + channel list).
  const subscribers = useRef<Map<string, Set<(e: ServerEvent) => void>>>(new Map())

  // Tracks in-flight messages/tools so we can accumulate text and write the
  // final payload to SQLite only on message_end / tool_end.
  const inFlight = useRef<Map<string, InFlight>>(new Map())

  // Serializes event handling. handleEvent is async, and onmessage fires it
  // per message without awaiting — so two events (notably a `status:working`
  // and a later `status:idle`) could otherwise race past their first await and
  // apply out of order, leaving a stuck "working" indicator. This is most acute
  // during the rapid get_missed_events replay burst after a reconnect. Chaining
  // through one promise applies events strictly in receipt (seq) order.
  const handlerChain = useRef<Promise<void>>(Promise.resolve())

  // ---------------------------------------------------------------------------
  // Fan-out helpers
  // ---------------------------------------------------------------------------

  function notify(key: string, event: ServerEvent) {
    subscribers.current.get(key)?.forEach((h) => h(event))
    subscribers.current.get('*')?.forEach((h) => h(event))
  }

  // ---------------------------------------------------------------------------
  // Event handler — persists to SQLite and fans out to subscribers
  // ---------------------------------------------------------------------------

  async function handleEvent(event: ServerEvent): Promise<void> {
    const serverId: string = ('serverId' in event ? event.serverId : undefined) ?? 'unknown'
    // The channel scopes the conversation within a server. Absent ⇒ 'general',
    // which preserves the original single-conversation-per-server behavior.
    const channel: string = 'channel' in event && event.channel ? event.channel : DEFAULT_CHANNEL
    const key = convKey(serverId, channel)
    const turnId: string | undefined =
      'turn_id' in event ? (event.turn_id as string | undefined) : undefined

    // New-message chime: a fresh incoming message (text or file). role !== 'user'
    // excludes the user's own echoes; the throttle inside the hook collapses any
    // reconnect-replay burst into a single ding. Suppressed for muted servers —
    // looked up async so we don't block event persistence; on a read error we
    // fail open and still chime. The hook's throttle absorbs the lookup latency.
    if ((event.type === 'message_start' || event.type === 'file') && event.role !== 'user') {
      getServer(db, serverId)
        .then((srv) => { if (!isServerMuted(srv)) playMessageSoundRef.current() })
        .catch(() => playMessageSoundRef.current())
    }

    // Touch both the server and channel rows. Server first — the channels table
    // has a FK to servers(id). This is also the auto-discovery path: a channel
    // appears in the list the moment any event references it.
    async function touchConversation(): Promise<void> {
      await upsertServer(db, serverId)
      await upsertChannel(db, serverId, channel)
    }

    try {
      switch (event.type) {
        case 'message_start': {
          inFlight.current.set(event.id, {
            kind: 'message',
            serverId,
            channel,
            turnId,
            role: event.role,
            text: '',
          })

          touchConversation().catch((err) =>
            console.warn('[WSContext] touchConversation error', err),
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
            await persistItem(db, {
              id: event.id,
              serverId: inf.serverId,
              channel: inf.channel,
              kind: 'message',
              data: { kind: 'message' as const, id: event.id, role: inf.role ?? 'assistant', text: inf.text ?? '', done: true, turnId: inf.turnId },
              turnId: inf.turnId,
            }, inf.text ?? '')

            // Telegram-style: an arriving agent message means it's done composing,
            // so clear any lingering "working/thinking" indicator. This self-heals
            // a stuck status when the agent's explicit `status:idle` never arrives
            // (crash, dropped event). A genuinely continuing turn re-emits
            // `status:working` on its next step, which restores the indicator.
            if (inf.role !== 'user') {
              await updateServerStatus(db, inf.serverId, 'idle')
              await updateChannelStatus(db, inf.serverId, inf.channel, 'idle')
            }
          }
          break
        }

        case 'tool_start': {
          // Same pattern as message_start — register inFlight synchronously,
          // no DB write until tool_end delivers the complete result.
          inFlight.current.set(event.id, {
            kind: 'tool',
            serverId,
            channel,
            turnId,
            name: event.name,
            args: event.args,
          })
          touchConversation().catch((err) =>
            console.warn('[WSContext] touchConversation error', err),
          )
          break
        }

        case 'tool_end': {
          const inf = inFlight.current.get(event.id)
          if (inf) {
            inFlight.current.delete(event.id)
            await persistItem(db, {
              id: event.id,
              serverId: inf.serverId,
              channel: inf.channel,
              kind: 'tool',
              data: { kind: 'tool', id: event.id, name: inf.name ?? 'unknown', args: inf.args ?? {}, result: event.result, done: true, turnId: inf.turnId },
              turnId: inf.turnId,
            })
          }
          // If there's no inFlight entry, tool_start was missed entirely — skip.
          break
        }

        case 'file': {
          // Single self-contained event — persist immediately (no inFlight).
          await persistItem(db, {
            id: event.id,
            serverId,
            channel,
            kind: 'file',
            data: { kind: 'file', id: event.id, role: event.role, mime: event.mime, data: event.data, name: event.name, duration: event.duration, text: event.text, done: true, turnId },
            turnId,
          }, filePreviewLabel(event))
          break
        }

        case 'permission_request': {
          await persistItem(db, {
            id: event.id, serverId, channel, kind: 'prompt', turnId,
            data: { kind: 'prompt', id: event.id, title: event.title, message: event.message, options: event.options, turnId },
          })
          break
        }

        case 'clarify': {
          await persistItem(db, {
            id: event.id, serverId, channel, kind: 'prompt', turnId,
            data: { kind: 'prompt', id: event.id, title: 'Clarification', message: event.question, options: event.choices, turnId },
          })
          break
        }

        case 'prompt_dismiss': {
          // Mirror the reducer (useChatSessionReducer): keep prompts this client
          // already resolved — respond() stamps resolved:true — and delete only
          // prompts dismissed elsewhere. Otherwise an answered approval card
          // would vanish from history on reload.
          const existing = await getItemById(db, event.id)
          let resolved = false
          if (existing?.kind === 'prompt') {
            try {
              resolved = (JSON.parse(existing.data) as { resolved?: boolean }).resolved === true
            } catch {
              /* malformed row — treat as unresolved */
            }
          }
          if (!resolved) await deleteItem(db, event.id)
          break
        }

        case 'status': {
          await touchConversation()
          await updateServerStatus(db, serverId, event.value)
          await updateChannelStatus(db, serverId, channel, event.value)
          break
        }

        case 'commands': {
          // Commands are server-level, not channel-scoped.
          await upsertServer(db, serverId)
          await saveCachedCommands(db, serverId, event.commands)
          break
        }

        case 'channels': {
          // Server-owned channel registry (the source of truth). Upsert each
          // entry into the local channels table as a thin cache. Server row
          // first (channels FK → servers). Channels removed server-side aren't
          // pruned here — the registry only grows via create_channel today.
          await upsertServer(db, event.serverId)
          for (const ch of event.channels) {
            await upsertChannel(db, event.serverId, ch.id)
          }
          break
        }

        case 'server_info': {
          // Adapter-advertised server metadata (mono-channel default, name).
          await applyServerInfo(db, event.serverId, {
            monoChannel: event.monoChannel,
            displayName: event.displayName,
          })
          break
        }

        default:
          break
      }
    } catch (err) {
      console.warn('[WSContext] DB error handling event', event.type, err)
    }

    // Fan out to subscribers regardless of DB success
    notify(key, event)

    // A new message/file changes the unread tally — keep the app-icon badge in
    // step (the item is already persisted above, so getUnreadCounts sees it).
    if (event.type === 'message_end' || event.type === 'file') {
      syncAppBadge(db).catch(() => {})
    }
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
        // Fresh connection: clear the per-connection dedup set (see seenSeqs).
        seenSeqs.current = new Set()
        socket.send(JSON.stringify({ type: 'get_commands' }))
        socket.send(JSON.stringify({ type: 'get_missed_events', after_seq: lastSeqRef.current }))
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
          const parsed = JSON.parse(e.data as string) as { seq?: number; event?: ServerEvent }
          const event: ServerEvent = parsed.event ?? (parsed as unknown as ServerEvent)
          if (parsed.seq !== undefined) {
            // Drop a redelivered event (live broadcast + offline replay can
            // overlap on reconnect) so append-only deltas aren't applied twice.
            if (seenSeqs.current.has(parsed.seq)) return
            seenSeqs.current.add(parsed.seq)
            if (parsed.seq > lastSeqRef.current) {
              lastSeqRef.current = parsed.seq
              // Debounce the SQLite write — text_delta arrives 10-20x/sec during
              // streaming; we only need the seq persisted before the next reconnect.
              if (seqFlushTimer.current) clearTimeout(seqFlushTimer.current)
              seqFlushTimer.current = setTimeout(() => {
                setSetting(db, 'ws_last_seq', String(lastSeqRef.current)).catch(() => {})
              }, 500)
            }
          }
          // Apply events strictly in order (see handlerChain) so status updates
          // can't race out of sequence.
          handlerChain.current = handlerChain.current
            .then(() => handleEvent(event))
            .catch((err) => console.warn('[WSContext] handleEvent error', err))
        } catch (err) {
          console.warn('[WSContext] parse error', err)
        }
      }
    }

    // Load the last seen seq from SQLite before first connect so we can
    // request only genuinely missed events (not replay already-stored ones).
    getSetting(db, 'ws_last_seq').then((val) => {
      if (val) lastSeqRef.current = parseInt(val, 10)
      connect()
    })

    // Reconcile the app-icon badge with persisted unread on launch.
    syncAppBadge(db).catch(() => {})

    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        // Re-sync the badge — unread may have changed while backgrounded (pushes
        // arrived) or been cleared by opening a chat on another device.
        syncAppBadge(db).catch(() => {})
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
      if (seqFlushTimer.current) {
        clearTimeout(seqFlushTimer.current)
        setSetting(db, 'ws_last_seq', String(lastSeqRef.current)).catch(() => {})
      }
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
    (key: string, handler: (e: ServerEvent) => void): (() => void) => {
      const set = subscribers.current.get(key) ?? new Set()
      set.add(handler)
      subscribers.current.set(key, set)
      return () => {
        set.delete(handler)
        if (set.size === 0) subscribers.current.delete(key)
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
