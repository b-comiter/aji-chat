/**
 * Encapsulates all user-initiated write actions for a chat session:
 *  - Sending messages (with local command interception)
 *  - Responding to agent prompts
 *  - Adding client-side system messages
 *  - Local slash command dispatch (with two-step guard for /wipe-db)
 *
 * Exposes LOCAL_COMMANDS so the screen can build the slash-command picker.
 */
import { useCallback, useRef } from 'react'
import { router } from 'expo-router'
import type { ClientEvent, CommandItem } from '@aji/protocol'
import { newId } from '@aji/protocol'
import type { SQLiteDatabase } from 'expo-sqlite'
import {
  clearAgentHistory,
  getDbDump,
  insertItem,
  updateAgentPreview,
  upsertAgent,
  wipeAllHistory,
} from '../db/database'
import type { Item } from './chatTypes'

const SERVER_PORT = process.env.EXPO_PUBLIC_SERVER_PORT ?? '4000'
const SERVER_HTTP = `http://${process.env.EXPO_PUBLIC_SERVER_HOST}:${SERVER_PORT}`

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 5000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Slash commands — local to the client, never forwarded to the server
// ---------------------------------------------------------------------------

export const LOCAL_COMMANDS: CommandItem[] = [
  { name: 'clear',             description: 'Clear chat history for this agent',                  category: 'Dev' },
  { name: 'view-db',           description: 'Dump database contents to server log',               category: 'Dev' },
  { name: 'view-chat-history', description: "Log this agent's chat messages to server console",   category: 'Dev', args_hint: '[with-tools]' },
  { name: 'view-last-n-msgs',  description: 'Log the last N messages to server console',          category: 'Dev', args_hint: '<count>' },
  { name: 'wipe-db',           description: 'Wipe ALL history for ALL agents',                    category: 'Dev' },
]

type SetItems = (updater: (prev: Item[]) => Item[]) => void

interface CommandContext {
  chatId?: string
  db: SQLiteDatabase
  items: Item[]
  setItems: SetItems
  addSystemMessage: (text: string) => void
  router: typeof router
}

type CommandHandler = (args: string[]) => Promise<void>
type CommandFactory = (ctx: CommandContext) => CommandHandler

const LOCAL_COMMAND_HANDLERS: Record<string, CommandFactory> = {
  clear: (ctx) => async () => {
    await clearAgentHistory(ctx.db, ctx.chatId ?? 'unknown')
    ctx.setItems(() => [])
    ctx.addSystemMessage('Chat history cleared.')
  },

  'view-db': (ctx) => async () => {
    const dump = await getDbDump(ctx.db)
    try {
      await fetchWithTimeout(`${SERVER_HTTP}/db/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dump),
      })
      ctx.addSystemMessage('DB dump sent to server log.')
    } catch {
      ctx.addSystemMessage('Could not reach server — is it running?')
    }
  },

  'view-chat-history': (ctx) => async (args) => {
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
      await fetchWithTimeout(`${SERVER_HTTP}/chat/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: ctx.chatId ?? 'unknown', items: payload }),
      })
      ctx.addSystemMessage(`Chat history sent to server log${withTools ? ' (with tools)' : ''}.`)
    } catch {
      ctx.addSystemMessage('Could not reach server — is it running?')
    }
  },

  'view-last-n-msgs': (ctx) => async (args) => {
    const countStr = args[0] || '10'
    const count = Math.max(1, parseInt(countStr, 10) || 10)
    const messages = ctx.items
      .filter((it): it is Extract<Item, { kind: 'message' }> => it.kind === 'message')
      .slice(-count)
    try {
      await fetchWithTimeout(`${SERVER_HTTP}/last-messages/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: ctx.chatId ?? 'unknown', messages }),
      })
      ctx.addSystemMessage(`Last ${count} message${count !== 1 ? 's' : ''} sent to server log.`)
    } catch {
      ctx.addSystemMessage('Could not reach server — is it running?')
    }
  },

  'wipe-db': (ctx) => async () => {
    await wipeAllHistory(ctx.db)
    ctx.setItems(() => [])
    ctx.router.replace('/')
  },
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseChatActionsParams {
  chatId: string | undefined
  db: SQLiteDatabase
  conn: 'connected' | 'connecting' | 'disconnected'
  sendEvent: (event: ClientEvent) => void
  items: Item[]
  setItems: SetItems
}

export function useChatActions({
  chatId,
  db,
  conn,
  sendEvent,
  items,
  setItems,
}: UseChatActionsParams) {
  // Mutable ref — always holds the latest items snapshot for command handlers
  // without making handleLocalCommand depend on items (which changes each delta)
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Two-step guard for /wipe-db
  const wipePendingRef = useRef(false)
  const wipePendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const addSystemMessage = useCallback((text: string) => {
    setItems((prev) => [
      ...prev,
      { kind: 'message', id: newId('sys'), role: 'system', text, done: true },
    ])
  }, [setItems])

  const respond = useCallback((promptId: string, choice: string) => {
    sendEvent({ type: 'prompt_response', id: promptId, choice })
    setItems((prev) => prev.filter((it) => !(it.kind === 'prompt' && it.id === promptId)))
  }, [sendEvent, setItems])

  const handleLocalCommand = useCallback(async (cmd: string, args: string[]): Promise<boolean> => {
    const factory = LOCAL_COMMAND_HANDLERS[cmd]
    if (!factory) return false

    // Two-step guard: first /wipe-db shows a warning; /wipe-db confirm executes
    if (cmd === 'wipe-db') {
      if (!wipePendingRef.current) {
        wipePendingRef.current = true
        wipePendingTimerRef.current = setTimeout(() => { wipePendingRef.current = false }, 10000)
        addSystemMessage('⚠️ This will wipe ALL history for ALL agents. Type /wipe-db confirm within 10s to proceed.')
        return true
      }
      if (args[0] !== 'confirm') {
        addSystemMessage('Type /wipe-db confirm to proceed, or wait for the 10s timeout to cancel.')
        return true
      }
      wipePendingRef.current = false
      if (wipePendingTimerRef.current) {
        clearTimeout(wipePendingTimerRef.current)
        wipePendingTimerRef.current = null
      }
    }

    const ctx: CommandContext = { chatId, db, items: itemsRef.current, setItems, addSystemMessage, router }
    try {
      await factory(ctx)(args)
      return true
    } catch (err) {
      console.error(`Command /${cmd} failed:`, err)
      addSystemMessage(`Error running /${cmd}: ${err instanceof Error ? err.message : 'unknown error'}`)
      return true
    }
  }, [chatId, db, addSystemMessage, setItems])

  // Accepts the trimmed text so the screen owns draft state and clearing.
  const sendMessage = useCallback((text: string) => {
    if (!text) return

    // Intercept local commands before forwarding to the server
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/)
      const cmd = parts[0]
      if (LOCAL_COMMANDS.some((c) => c.name === cmd)) {
        handleLocalCommand(cmd, parts.slice(1)).catch(console.warn)
        return
      }
    }

    if (conn !== 'connected') return

    const msgId = newId('msg')
    const msgData: Item = { kind: 'message', id: msgId, role: 'user', text, done: true }

    setItems((prev) => [...prev, msgData])
    sendEvent({ type: 'user_message', text })

    if (chatId) {
      upsertAgent(db, chatId)
        .then(() => insertItem(db, { id: msgId, chatId, kind: 'message', data: msgData }))
        .then(() => updateAgentPreview(db, chatId, text))
        .catch(console.warn)
    }
  }, [conn, chatId, db, sendEvent, setItems, handleLocalCommand])

  return { sendMessage, addSystemMessage, respond }
}
