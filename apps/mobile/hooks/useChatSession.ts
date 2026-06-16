/**
 * Manages all conversation state for a single chat using a sliding window pattern.
 *
 * **Data flow:**
 *  1. On mount: load 100 most recent items from SQLite
 *  2. In-memory: append live WS events (message_start, text_delta, tool_start, etc.)
 *  3. Pagination: when user scrolls to visual top, load 100 older items, prepend to window
 *  4. Window limit: cap at 200 items total; oldest drop off on pagination and live appends
 *  5. Persistence: WSContext persists arriving events to SQLite; user messages persisted by useChatActions
 *
 * **Items are always stored chronologically** (oldest first → newest last):
 *  - Makes DB queries simpler (loadRecentItems, loadOlderThan are chronological)
 *  - Makes event handling simpler (append new items to end)
 *  - MessageList.tsx reverses for display (inverted FlatList)
 *
 * **Why no scroll position save/restore:**
 *  - Inverted FlatList naturally opens at bottom (newest message)
 *  - When user scrolls up and new messages arrive, they don't get yanked (acceptable trade-off)
 *  - WhatsApp/Telegram also don't restore scroll position across sessions
 *  - Alternative (complex save/restore) caused more jitter than this simple approach
 *
 * See docs/chat-scroll-architecture.md for full design rationale.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStatus, CommandItem, ServerEvent } from '@aji/protocol'
import type { SQLiteDatabase } from 'expo-sqlite'
import { loadCachedCommands, loadOlderThan, loadRecentItems } from '../db/database'
import type { ItemRow } from '../db/database'
import { convKey } from '../db/convKey'
import { rowToItem } from './chatTypes'
import type { Item } from './chatTypes'
import { tryApprovalPrompt } from './hermesApproval'
import { reduceItemsForServerEvent } from './useChatSessionReducer'
import type { ConnStatus } from '../context/WebSocketContext'

const WINDOW_LIMIT = 200
const BATCH_SIZE = 100
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000

// Hermes approval requests are transmitted as text messages and converted to
// prompt items by tryApprovalPrompt during DB intake and WS message completion.

type SubscribeFn = (
  chatId: string,
  handler: (event: ServerEvent) => void,
) => () => void

export function useChatSession(
  chatId: string | undefined,
  channel: string,
  db: SQLiteDatabase,
  subscribe: SubscribeFn,
  conn: ConnStatus,
) {
  const [items, setItems] = useState<Item[]>([])
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle')
  const [commands, setCommands] = useState<CommandItem[]>([])
  const [hasMoreOlder, setHasMoreOlder] = useState(false)

  // Cursor tracks the local_id of the oldest DB-backed item in the window.
  // May lag for items added via WS or useChatActions (no local_id yet) —
  // dedup by item.id on every fetch handles that gap.
  const oldestLocalIdRef = useRef<number | null>(null)
  const localIdMapRef = useRef<Map<string, number>>(new Map())

  const loadingOlderRef = useRef(false)
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current)
      inactivityTimerRef.current = null
    }
  }, [])

  const resetInactivityTimer = useCallback(() => {
    clearInactivityTimer()
    inactivityTimerRef.current = setTimeout(() => {
      setAgentStatus('idle')
    }, INACTIVITY_TIMEOUT_MS)
  }, [clearInactivityTimer])

  // For live appends, keep the newest WINDOW_LIMIT items by dropping oldest.
  const capLiveWindow = useCallback((arr: Item[]): Item[] => {
    if (arr.length <= WINDOW_LIMIT) return arr
    return arr.slice(arr.length - WINDOW_LIMIT)
  }, [])

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
      // Items stored as 'message' that are still unresolved approval requests get
      // converted to prompt cards on load. Items already answered have been
      // overwritten to { kind: 'prompt', resolved: true } by respond(), so they
      // come back as resolved stubs and skip this branch.
      const converted = item.kind === 'message' ? tryApprovalPrompt(item) : null
      out.push(converted ?? item)
    }
    return out
  }, [])

  // Update the older-cursor from the current items by looking up local_ids in
  // the map. Items added via WS/actions may not have a local_id yet; we leave
  // the cursor at whatever was last known (it'll catch up on the next DB fetch).
  const refreshOldestCursor = useCallback((arr: Item[]) => {
    if (arr.length === 0) {
      oldestLocalIdRef.current = null
      return
    }
    const headId = localIdMapRef.current.get(arr[0].id)
    if (headId != null) oldestLocalIdRef.current = headId
  }, [])

  // Reset status to idle when the WS connection drops — the agent is unreachable
  // and any in-progress work can no longer be tracked.
  useEffect(() => {
    if (conn === 'disconnected') {
      setAgentStatus('idle')
      clearInactivityTimer()
    }
  }, [conn, clearInactivityTimer])

  // -------------------------------------------------------------------------
  // Initial load
  // -------------------------------------------------------------------------
  useEffect(() => {
    // Reset all hook state when chat target changes.
    setItems([])
    setCommands([])
    setHasMoreOlder(false)
    setAgentStatus('idle')
    clearInactivityTimer()

    oldestLocalIdRef.current = null
    localIdMapRef.current = new Map()
    loadingOlderRef.current = false

    if (!chatId) return
    let cancelled = false

    async function load() {
      const cursorRows: ItemRow[] = await loadRecentItems(db, chatId!, channel, BATCH_SIZE)
      const intaken = intakeRows(cursorRows)

      if (cancelled) return

      if (cursorRows.length > 0) {
        oldestLocalIdRef.current = cursorRows[0].local_id
      }

      // Merge: keep any in-flight WS-added items that arrived during the load
      setItems((current) => {
        if (current.length === 0) return intaken
        const dbIds = new Set(intaken.map((i) => i.id))
        const inFlight = current.filter((i) => !dbIds.has(i.id))
        return [...intaken, ...inFlight]
      })
      setHasMoreOlder(cursorRows.length === BATCH_SIZE)
    }

    load().catch((err) => console.warn('[useChatSession] initial load failed', err))

    return () => {
      cancelled = true
      clearInactivityTimer()
    }
  }, [db, chatId, channel, intakeRows, clearInactivityTimer])

  // Hydrate slash command cache for this chat so reload/offline still shows picker data.
  useEffect(() => {
    if (!chatId) {
      setCommands([])
      return
    }
    let cancelled = false
    loadCachedCommands(db, chatId)
      .then((cached) => {
        if (!cancelled) setCommands(cached)
      })
      .catch((err) => console.warn('[useChatSession] loadCachedCommands failed', err))

    return () => {
      cancelled = true
    }
  }, [db, chatId])

  // -------------------------------------------------------------------------
  // Pagination — older only. We never page "newer" because the window is
  // always anchored at the DB tail (latest messages) and live arrivals append
  // via the WS handler below.
  // -------------------------------------------------------------------------
  const loadOlder = useCallback(async () => {
    if (!chatId || loadingOlderRef.current) return
    const cursor = oldestLocalIdRef.current
    if (cursor == null) return
    loadingOlderRef.current = true
    try {
      const rows = await loadOlderThan(db, chatId, channel, cursor, BATCH_SIZE)
      if (rows.length === 0) {
        setHasMoreOlder(false)
        return
      }

      // Always move the cursor so duplicate-only pages don't loop forever.
      oldestLocalIdRef.current = Math.min(...rows.map((row) => row.local_id))

      setItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.id))
        const fresh = intakeRows(rows, existingIds)
        if (fresh.length === 0) return prev
        let next = [...fresh, ...prev]
        if (next.length > WINDOW_LIMIT) next = next.slice(0, WINDOW_LIMIT)
        refreshOldestCursor(next)
        return next
      })
      setHasMoreOlder(rows.length === BATCH_SIZE)
    } catch (err) {
      console.warn('[useChatSession] loadOlder failed', err)
    } finally {
      loadingOlderRef.current = false
    }
  }, [chatId, channel, db, intakeRows, refreshOldestCursor])

  // -------------------------------------------------------------------------
  // WS event handler — appends live arrivals to the in-memory window.
  // -------------------------------------------------------------------------
  const handleEvent = useCallback((event: ServerEvent) => {
    const turnId = 'turn_id' in event ? (event.turn_id as string | undefined) : undefined

    if (event.type === 'status') {
      setAgentStatus(event.value)
      if (event.value === 'idle') {
        clearInactivityTimer()
      } else {
        resetInactivityTimer()
      }
      return
    }
    if (event.type === 'commands') {
      setCommands(event.commands)
      return
    }

    // Any non-status, non-commands event from the agent is a sign of life —
    // reset the inactivity timer so we only auto-idle on true silence.
    resetInactivityTimer()

    setItems((prev) =>
      reduceItemsForServerEvent(prev, event, turnId, {
        capWindow: capLiveWindow,
        tryApprovalPrompt,
      }),
    )
  }, [capLiveWindow, clearInactivityTimer, resetInactivityTimer])

  useEffect(() => {
    if (!chatId) return
    return subscribe(convKey(chatId, channel), handleEvent)
  }, [chatId, channel, subscribe, handleEvent])

  return {
    items,
    setItems,
    agentStatus,
    commands,
    hasMoreOlder,
    loadOlder,
  }
}
