/**
 * Manages all conversation state for a single chat:
 *  - Loads history from SQLite on mount
 *  - Subscribes to live WS events and applies them to the items array
 *  - Persists completed assistant messages back to SQLite
 *  - Tracks agent status and server-sent command list
 *
 * Owns the items setState so that every mutation goes through one place.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStatus, ClientEvent, CommandItem, ServerEvent } from '@aji/protocol'
import type { SQLiteDatabase } from 'expo-sqlite'
import { getItemsForAgent, insertItem, upsertAgent } from '../db/database'
import { ensureMessageExists, rowToItem } from './chatTypes'
import type { Item } from './chatTypes'

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

  // IDs already written to SQLite — prevents double-writes on remount
  const persistedIdsRef = useRef(new Set<string>())

  // Load history from SQLite on mount.
  // Deduplicates by id (no UNIQUE constraint on items.id in the schema).
  // Filters out incomplete streaming messages to avoid rehydrating orphaned cursors.
  // Uses a functional update so WS items that arrived during the async read are preserved.
  useEffect(() => {
    if (!chatId) return
    getItemsForAgent(db, chatId).then((rows) => {
      rows.forEach((row) => persistedIdsRef.current.add(row.id))
      setItems((current) => {
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
  // persistedIdsRef guards against double-writes across effect re-runs.
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
  // WS event handler
  // Events may arrive out of sequence. ensureMessageExists guards against
  // missing message_start:
  //   • text_delta before message_start  → creates placeholder
  //   • message_start after text_delta   → skips (already exists)
  //   • message_end before message_start → creates done:true placeholder
  // ---------------------------------------------------------------------------

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

  useEffect(() => {
    if (!chatId) return
    return subscribe(chatId, handleEvent)
  }, [chatId, subscribe, handleEvent])

  return { items, setItems, agentStatus, commands }
}
