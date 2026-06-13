/**
 * Encapsulates all user-initiated write actions for a chat session:
 *  - Sending messages (with local command interception)
 *  - Responding to agent prompts
 *  - Adding client-side system messages
 *  - Local slash command dispatch (with two-step guard for /wipe-db)
 *  - Sending voice recordings and file attachments
 *
 * Exposes LOCAL_COMMANDS so the screen can build the slash-command picker.
 */
import { useCallback, useRef } from 'react'
import { router } from 'expo-router'
import type { ClientEvent, CommandItem } from '@aji/protocol'
import { newId, userFileMessage } from '@aji/protocol'
import type { SQLiteDatabase } from 'expo-sqlite'
import { File } from 'expo-file-system'
import {
  clearServerHistory,
  getDbDump,
  persistItem,
  updateItemData,
  wipeAllHistory,
} from '../db/database'
import { SERVER_CONFIG } from '../constants/server'
import type { Item } from './chatTypes'
import { useMessageSound } from './useMessageSound'

const SERVER_HTTP = SERVER_CONFIG.httpBase
const SERVER_TOKEN = SERVER_CONFIG.token

function ajiHeaders(): Record<string, string> {
  return SERVER_TOKEN ? { 'X-Aji-Token': SERVER_TOKEN } : {}
}

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
  { name: 'clear',             description: 'Clear chat history for this channel',                category: 'Dev' },
  { name: 'view-db',           description: 'Dump database contents to server log',               category: 'Dev' },
  { name: 'view-chat-history', description: "Log this agent's chat messages to server console",   category: 'Dev', args_hint: '[with-tools]' },
  { name: 'view-last-n-msgs',  description: 'Log the last N messages to server console',          category: 'Dev', args_hint: '<count>' },
  { name: 'wipe-db',           description: 'Wipe ALL history for ALL agents',                    category: 'Dev' },
  { name: 'test-alert',        description: 'Play the new-message alert sound',                   category: 'Dev' },
]

type SetItems = (updater: (prev: Item[]) => Item[]) => void

interface CommandContext {
  chatId?: string
  channel: string
  db: SQLiteDatabase
  items: Item[]
  setItems: SetItems
  addSystemMessage: (text: string) => void
  sendEvent: (event: ClientEvent) => void
  router: typeof router
  /** Plays the new-message chime — same sound used for incoming messages. */
  playMessageSound: () => void
}

type CommandHandler = (args: string[]) => Promise<void>
type CommandFactory = (ctx: CommandContext) => CommandHandler

const LOCAL_COMMAND_HANDLERS: Record<string, CommandFactory> = {
  clear: (ctx) => async () => {
    await clearServerHistory(ctx.db, ctx.chatId ?? 'unknown', ctx.channel)
    ctx.setItems(() => [])
    // Tell the agent to reset its own session for this channel too — clearing
    // only the client would leave the agent's history/context out of sync.
    ctx.sendEvent({
      type: 'clear_channel',
      ...(ctx.chatId ? { serverId: ctx.chatId } : {}),
      channel: ctx.channel,
    })
    ctx.addSystemMessage('Chat history cleared.')
  },

  'view-db': (ctx) => async () => {
    const dump = await getDbDump(ctx.db)
    try {
      await fetchWithTimeout(`${SERVER_HTTP}/db/dump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ajiHeaders() },
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
        headers: { 'Content-Type': 'application/json', ...ajiHeaders() },
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
        headers: { 'Content-Type': 'application/json', ...ajiHeaders() },
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

  'test-alert': (ctx) => async () => {
    ctx.playMessageSound()
    ctx.addSystemMessage('Played the new-message alert sound.')
  },
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseChatActionsParams {
  chatId: string | undefined
  channel: string
  db: SQLiteDatabase
  conn: 'connected' | 'connecting' | 'disconnected'
  sendEvent: (event: ClientEvent) => void
  items: Item[]
  setItems: SetItems
}

export function useChatActions({
  chatId,
  channel,
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

  // New-message chime — exposed to /test-alert so the sound can be triggered on
  // demand (same player/sound the incoming-message path uses).
  const playMessageSound = useMessageSound()

  // Two-step guard for /wipe-db
  const wipePendingRef = useRef(false)
  const wipePendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const addSystemMessage = useCallback((text: string) => {
    setItems((prev) => [
      ...prev,
      { kind: 'message', id: newId('sys'), role: 'system', text, done: true, createdAt: Date.now() },
    ])
  }, [setItems])

  const respond = useCallback((promptId: string, choice: string) => {
    // Optimistic UI: mark the card resolved immediately.
    setItems((prev) => prev.map((it) => {
      if (it.kind !== 'prompt' || it.id !== promptId) return it
      const choiceLabel = it.options.find((o) => o.id === choice)?.label ?? choice
      return { ...it, resolved: true, resolvedChoice: choice, choiceLabel }
    }))

    // Hermes text-approval choices are slash commands (/approve, /deny, etc.).
    // Send them as a plain user_message to the agent rather than a prompt_response
    // — there is no server-side waiter for these, they are Hermes's own text protocol.
    const send = () => {
      if (choice.startsWith('/')) {
        sendEvent({ type: 'user_message', text: choice, ...(chatId ? { serverId: chatId } : {}), channel })
      } else {
        sendEvent({ type: 'prompt_response', id: promptId, choice })
      }
    }

    // Persist resolved state BEFORE sending, so the prompt_dismiss the server
    // broadcasts back can't delete the row before it's marked resolved (which
    // would drop the answered card from history on reload — see the
    // prompt_dismiss handler in WebSocketContext). Send regardless if the write
    // fails: the user's response must never be blocked by a DB error.
    const current = itemsRef.current.find(
      (it): it is Extract<Item, { kind: 'prompt' }> => it.kind === 'prompt' && it.id === promptId,
    )
    if (current) {
      const choiceLabel = current.options.find((o) => o.id === choice)?.label ?? choice
      updateItemData(db, promptId, { ...current, resolved: true, resolvedChoice: choice, choiceLabel })
        .then(send)
        .catch((err) => { console.warn(err); send() })
    } else {
      send()
    }
  }, [chatId, channel, db, sendEvent, setItems])

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

    const ctx: CommandContext = { chatId, channel, db, items: itemsRef.current, setItems, addSystemMessage, sendEvent, router, playMessageSound }
    try {
      await factory(ctx)(args)
      return true
    } catch (err) {
      console.error(`Command /${cmd} failed:`, err)
      addSystemMessage(`Error running /${cmd}: ${err instanceof Error ? err.message : 'unknown error'}`)
      return true
    }
  }, [chatId, channel, db, addSystemMessage, setItems, sendEvent, playMessageSound])

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

    if (conn !== 'connected') {
      addSystemMessage('Not connected — reconnect to send.')
      return
    }

    const msgId = newId('msg')
    const msgData: Item = { kind: 'message', id: msgId, role: 'user', text, done: true, createdAt: Date.now() }

    setItems((prev) => [...prev, msgData])
    // Stamp the target server (chatId) + channel so server-side adapters — e.g.
    // the Hermes plugin — route this message to the right per-channel session.
    sendEvent({ type: 'user_message', text, ...(chatId ? { serverId: chatId } : {}), channel })

    if (chatId) {
      persistItem(db, { id: msgId, serverId: chatId, channel, kind: 'message', data: msgData }, text)
        .catch(console.warn)
    }
  }, [conn, chatId, channel, db, sendEvent, setItems, addSystemMessage, handleLocalCommand])

  // Shared file-send path behind sendAudio + sendAttachment. Reads the local URI
  // as base64, optimistically appends a `file` Item (so the AudioMessage row /
  // generic chip renders immediately), dispatches `user_file` over the websocket,
  // and persists. The wire event is `user_file` rather than `user_message`.
  // Returns true once the message has been dispatched, false on any early-out.
  const sendFile = useCallback(async (opts: {
    uri: string
    mime: string
    name?: string
    duration?: number
    previewLabel: string
    readErrorLabel: string
  }): Promise<boolean> => {
    if (conn !== 'connected') {
      addSystemMessage('Not connected — reconnect to send.')
      return false
    }
    const { uri, mime, name, duration } = opts
    let base64: string
    try {
      base64 = await new File(uri).base64()
    } catch (err) {
      console.warn('[useChatActions] failed to read file', err)
      addSystemMessage(opts.readErrorLabel)
      return false
    }

    const fileId = newId('file')
    const localItem: Item = {
      kind: 'file',
      id: fileId,
      role: 'user',
      mime,
      data: base64,
      ...(name !== undefined ? { name } : {}),
      ...(duration !== undefined ? { duration } : {}),
      done: true,
      createdAt: Date.now(),
    }

    setItems((prev) => [...prev, localItem])
    sendEvent(userFileMessage(mime, base64, {
      ...(name !== undefined ? { name } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(chatId ? { serverId: chatId } : {}),
      channel,
    }))

    if (chatId) {
      persistItem(db, { id: fileId, serverId: chatId, channel, kind: 'file', data: localItem }, opts.previewLabel)
        .catch(console.warn)
    }
    return true
  }, [conn, chatId, channel, db, sendEvent, setItems, addSystemMessage])

  // Voice mode: ship a recorded audio clip to the agent.
  const sendAudio = useCallback(async (uri: string, durationMs: number) => {
    const sent = await sendFile({
      uri,
      mime: 'audio/mp4',
      name: 'voice-message.m4a',
      duration: Math.max(0, durationMs / 1000),
      previewLabel: '🎤 Voice message',
      readErrorLabel: 'Could not read the recording.',
    })
    // Drop the temp recording file once it's been handed off — the local Item's
    // base64 (and AudioMessage's own cache file keyed by item id) handle replay
    // independently. On an early-out we leave it for a possible retry.
    if (sent) { try { new File(uri).delete() } catch {} }
  }, [sendFile])

  // General-purpose attachment sender. Shared by camera, photo library, and
  // file picker — all of them resolve to a local URI + mime + optional name.
  const sendAttachment = useCallback((opts: {
    uri: string
    mime: string
    name?: string
  }) => sendFile({
    uri: opts.uri,
    mime: opts.mime,
    name: opts.name,
    previewLabel: opts.name ? `📎 ${opts.name}` : '📎 Attachment',
    readErrorLabel: 'Could not read the attachment.',
  }).then(() => {}), [sendFile])

  return { sendMessage, sendAudio, sendAttachment, addSystemMessage, respond }
}
