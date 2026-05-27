/**
 * Manages all conversation state for a single chat using a sliding window:
 *  - Loads a bounded window of items from SQLite (max 200)
 *  - Pages older items in when the user scrolls near the top
 *  - Pages newer items in when the user scrolls near the bottom
 *  - Trims the side furthest from the user's viewport to enforce the ceiling
 *  - Subscribes to live WS events; only applies them in-memory when the window
 *    already contains the DB tail (otherwise persistence-only via WSContext)
 *  - Restores the exact saved scroll position on re-entry
 *
 * Persistence note: WSContext is the single writer for assistant/tool/prompt
 * rows arriving over the wire. This hook does NOT double-persist them. User
 * messages are persisted by useChatActions itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStatus, CommandItem, ServerEvent } from '@aji/protocol'
import type { SQLiteDatabase } from 'expo-sqlite'
import {
  getSetting,
  loadAroundItem,
  loadNewerThan,
  loadOlderThan,
  loadRecentItems,
} from '../db/database'
import type { ItemRow } from '../db/database'
import { ensureMessageExists, rowToItem } from './chatTypes'
import type { Item } from './chatTypes'

const WINDOW_LIMIT = 200
const BATCH_SIZE = 100

export type SavedPosition = { topItemId: string; offset: number }

type SubscribeFn = (
  chatId: string,
  handler: (event: ServerEvent) => void,
) => () => void

export function useChatSession(
  chatId: string | undefined,
  db: SQLiteDatabase,
  conn: 'connected' | 'connecting' | 'disconnected',
  subscribe: SubscribeFn,
) {
  const [items, setItems] = useState<Item[]>([])
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle')
  const [commands, setCommands] = useState<CommandItem[]>([])
  const [initialPosition, setInitialPosition] = useState<SavedPosition | null>(null)
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [hasMoreNewer, setHasMoreNewer] = useState(false)

  // Cursors track the local_id of the oldest/newest DB-backed item in the window.
  // They may lag for items added via WS or useChatActions (no local_id yet) —
  // dedup by item.id on every fetch handles that gap.
  const oldestLocalIdRef = useRef<number | null>(null)
  const newestLocalIdRef = useRef<number | null>(null)
  const localIdMapRef = useRef<Map<string, number>>(new Map())

  // Mirror hasMoreNewer so the WS handler avoids appending when in history mode
  const hasMoreNewerRef = useRef(false)
  hasMoreNewerRef.current = hasMoreNewer

  const loadingOlderRef = useRef(false)
  const loadingNewerRef = useRef(false)

  // Filter & dedup raw rows; populate the local_id map as a side effect.
  // Returns Item[] in the same order as input rows.
  const intakeRows = useCallback((rows: ItemRow[], skipIds?: Set<string>): Item[] => {
    const out: Item[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      localIdMapRef.current.set(row.id, row.local_id)
      if (skipIds?.has(row.id)) continue
      const item = rowToItem(row)
      // Drop orphaned streaming-cursor rows (incomplete non-user messages).
      if (item.kind === 'message' && item.role !== 'user' && !item.done) continue
      out.push(item)
    }
    return out
  }, [])

  // Update cursors from the current items by looking up local_ids in the map.
  // Items added via WS/actions may not have a local_id yet; we leave the cursor
  // at whatever was last known (it will catch up on the next DB fetch).
  const refreshCursors = useCallback((arr: Item[]) => {
    if (arr.length === 0) {
      oldestLocalIdRef.current = null
      newestLocalIdRef.current = null
      return
    }
    const headId = localIdMapRef.current.get(arr[0].id)
    const tailId = localIdMapRef.current.get(arr[arr.length - 1].id)
    if (headId != null) oldestLocalIdRef.current = headId
    if (tailId != null) newestLocalIdRef.current = tailId
  }, [])

  // -------------------------------------------------------------------------
  // Initial load
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!chatId) return
    let cancelled = false

    // Reset all hook state for the new chat
    oldestLocalIdRef.current = null
    newestLocalIdRef.current = null
    localIdMapRef.current = new Map()
    loadingOlderRef.current = false
    loadingNewerRef.current = false

    async function load() {
      const raw = await getSetting(db, `scroll_pos:${chatId}`)
      let savedPos: SavedPosition | null = null
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed.topItemId === 'string') savedPos = parsed
        } catch {
          /* ignore malformed setting */
        }
      }

      let intaken: Item[] = []
      let cursorRows: ItemRow[] = []
      let nextHasMoreOlder = false
      let nextHasMoreNewer = false

      if (savedPos) {
        const around = await loadAroundItem(db, chatId!, savedPos.topItemId, 100, 100)
        if (around) {
          cursorRows = [...around.before, ...around.after]
          intaken = intakeRows(cursorRows)
          nextHasMoreOlder = around.before.length === 100
          nextHasMoreNewer = around.after.length === 100
        } else {
          // Saved item is gone — drop the stale setting & fall through to recent
          savedPos = null
        }
      }

      if (cursorRows.length === 0) {
        cursorRows = await loadRecentItems(db, chatId!, BATCH_SIZE)
        intaken = intakeRows(cursorRows)
        nextHasMoreOlder = cursorRows.length === BATCH_SIZE
        nextHasMoreNewer = false
      }

      if (cancelled) return

      if (cursorRows.length > 0) {
        oldestLocalIdRef.current = cursorRows[0].local_id
        newestLocalIdRef.current = cursorRows[cursorRows.length - 1].local_id
      }

      // Merge: keep any in-flight WS-added items that arrived during the load
      setItems((current) => {
        if (current.length === 0) return intaken
        const dbIds = new Set(intaken.map((i) => i.id))
        const inFlight = current.filter((i) => !dbIds.has(i.id))
        return [...intaken, ...inFlight]
      })
      setHasMoreOlder(nextHasMoreOlder)
      setHasMoreNewer(nextHasMoreNewer)
      setInitialPosition(savedPos)
    }

    load().catch((err) => console.warn('[useChatSession] initial load failed', err))

    return () => {
      cancelled = true
    }
  }, [db, chatId, intakeRows])

  // Clear stale server-sent commands when the connection drops
  useEffect(() => {
    if (conn === 'disconnected') setCommands([])
  }, [conn])

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------
  const loadOlder = useCallback(async () => {
    if (!chatId || loadingOlderRef.current) return
    const cursor = oldestLocalIdRef.current
    if (cursor == null) return
    loadingOlderRef.current = true
    try {
      const rows = await loadOlderThan(db, chatId, cursor, BATCH_SIZE)
      if (rows.length === 0) {
        setHasMoreOlder(false)
        return
      }
      let evicted = false
      setItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.id))
        const fresh = intakeRows(rows, existingIds)
        if (fresh.length === 0) return prev
        let next = [...fresh, ...prev]
        if (next.length > WINDOW_LIMIT) {
          evicted = true
          next = next.slice(0, WINDOW_LIMIT)
        }
        refreshCursors(next)
        return next
      })
      setHasMoreOlder(rows.length === BATCH_SIZE)
      if (evicted) setHasMoreNewer(true)
    } catch (err) {
      console.warn('[useChatSession] loadOlder failed', err)
    } finally {
      loadingOlderRef.current = false
    }
  }, [chatId, db, intakeRows, refreshCursors])

  const loadNewer = useCallback(async () => {
    if (!chatId || loadingNewerRef.current) return
    const cursor = newestLocalIdRef.current
    if (cursor == null) return
    loadingNewerRef.current = true
    try {
      const rows = await loadNewerThan(db, chatId, cursor, BATCH_SIZE)
      if (rows.length === 0) {
        setHasMoreNewer(false)
        return
      }
      let evicted = false
      setItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.id))
        const fresh = intakeRows(rows, existingIds)
        if (fresh.length === 0) return prev
        let next = [...prev, ...fresh]
        if (next.length > WINDOW_LIMIT) {
          evicted = true
          next = next.slice(next.length - WINDOW_LIMIT)
        }
        refreshCursors(next)
        return next
      })
      setHasMoreNewer(rows.length === BATCH_SIZE)
      if (evicted) setHasMoreOlder(true)
    } catch (err) {
      console.warn('[useChatSession] loadNewer failed', err)
    } finally {
      loadingNewerRef.current = false
    }
  }, [chatId, db, intakeRows, refreshCursors])

  // -------------------------------------------------------------------------
  // WS event handler
  // Only mutates in-memory items when we already have the DB tail in the
  // window. Otherwise we let WSContext persist and drop the in-memory update —
  // the user will see the message when they scroll back down to the tail.
  // Streaming text_delta and message updates for items already in the window
  // pass through regardless (they don't change the window boundary).
  // -------------------------------------------------------------------------
  const handleEvent = useCallback((event: ServerEvent) => {
    const turnId = 'turn_id' in event ? (event.turn_id as string | undefined) : undefined

    if (event.type === 'status') {
      setAgentStatus(event.value)
      return
    }
    if (event.type === 'commands') {
      setCommands(event.commands)
      return
    }

    setItems((prev) => {
      const inWindow = (id: string): boolean => prev.some((it) => it.id === id)

      switch (event.type) {
        case 'message_start':
          // Only add NEW messages to memory if we're at the tail; otherwise drop.
          if (inWindow(event.id)) return prev
          if (hasMoreNewerRef.current) return prev
          return ensureMessageExists(prev, event.id, turnId)

        case 'text_delta': {
          if (inWindow(event.id)) {
            return prev.map((it) =>
              it.kind === 'message' && it.id === event.id
                ? { ...it, text: it.text + event.text }
                : it,
            )
          }
          // Out-of-order: text_delta arrived before message_start. Only create
          // the placeholder if we're at the DB tail; otherwise drop (matches
          // the gate applied to message_start).
          if (hasMoreNewerRef.current) return prev
          const created = ensureMessageExists(prev, event.id, turnId)
          return created.map((it) =>
            it.kind === 'message' && it.id === event.id
              ? { ...it, text: it.text + event.text }
              : it,
          )
        }

        case 'message_end': {
          if (inWindow(event.id)) {
            return prev.map((it) =>
              it.kind === 'message' && it.id === event.id ? { ...it, done: true } : it,
            )
          }
          if (hasMoreNewerRef.current) return prev
          return [
            ...prev,
            { kind: 'message', id: event.id, role: 'assistant', text: '', done: true, turnId },
          ]
        }

        case 'tool_start':
          if (inWindow(event.id)) return prev
          if (hasMoreNewerRef.current) return prev
          return [
            ...prev,
            {
              kind: 'tool',
              id: event.id,
              name: event.name,
              args: event.args,
              done: false,
              turnId,
            },
          ]

        case 'tool_end':
          if (!inWindow(event.id)) return prev
          return prev.map((it) =>
            it.kind === 'tool' && it.id === event.id
              ? { ...it, result: event.result, done: true }
              : it,
          )

        case 'permission_request':
          if (inWindow(event.id)) return prev
          if (hasMoreNewerRef.current) return prev
          return [
            ...prev,
            {
              kind: 'prompt',
              id: event.id,
              title: event.title,
              message: event.message,
              options: event.options,
              turnId,
            },
          ]

        case 'clarify':
          if (inWindow(event.id)) return prev
          if (hasMoreNewerRef.current) return prev
          return [
            ...prev,
            {
              kind: 'prompt',
              id: event.id,
              title: 'Clarification',
              message: event.question,
              options: event.choices,
              turnId,
            },
          ]

        case 'prompt_dismiss':
          return prev.filter((it) => !(it.kind === 'prompt' && it.id === event.id))

        default:
          return prev
      }
    })
  }, [])

  useEffect(() => {
    if (!chatId) return
    return subscribe(chatId, handleEvent)
  }, [chatId, subscribe, handleEvent])

  return {
    items,
    setItems,
    agentStatus,
    commands,
    initialPosition,
    hasMoreOlder,
    hasMoreNewer,
    loadOlder,
    loadNewer,
  }
}
