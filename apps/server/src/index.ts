import type { Server as HttpServer } from 'node:http'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientEvent, Commands, PermissionRequest, PromptResponse, ServerEvent } from '@aji/protocol'
import { textMessage } from '@aji/protocol'

const PORT = 4000

const app = new Hono()
app.use('*', cors())
const clients = new Set<WebSocket>()
const webhooks = new Set<string>()
const promptWaiters = new Map<string, { resolve: (event: PromptResponse | null) => void }>()

// Latest commands per agent — keyed by event.agent, falling back to '__global__'.
// Replayed to every new WS client on connect so late-joining screens don't miss them.
const commandsCache = new Map<string, Commands>()

// Ring buffer of recent events for offline-reconnect replay.
// Clients send get_missed_events with their last known seq; server replays entries
// with seq > after_seq back to that client only.
const MAX_BUFFER = 500
const eventBuffer: Array<{ seq: number; event: ServerEvent }> = []
let nextSeq = 0

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

function log(direction: '➡️' | '⬅️' | '✅' | '❌' | ' ', tag: string, detail?: unknown): void {
  const prefix = `[${ts()}] ${direction} ${tag}`
  if (detail === undefined) {
    console.log(prefix)
  } else if (typeof detail === 'string') {
    console.log(`${prefix}  ${detail}`)
  } else {
    console.log(`${prefix}  ${JSON.stringify(detail, null, 2)}`)
  }
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

function bufferAndSend(ws: WebSocket, event: ServerEvent): void {
  const seq = nextSeq++
  eventBuffer.push({ seq, event })
  if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift()
  ws.send(JSON.stringify({ seq, event }))
}

function replayCommandsTo(ws: WebSocket): void {
  for (const cached of commandsCache.values()) {
    bufferAndSend(ws, cached)
  }
}

function broadcast(event: ServerEvent): number {
  const seq = nextSeq++
  eventBuffer.push({ seq, event })
  if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift()

  const payload = JSON.stringify({ seq, event })
  let sent = 0
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload)
      sent += 1
    }
  }
  if (event.type === 'file') {
    // Don't log the full base64 data for files — can be huge and floods the console.
    log(' ', '(file event data omitted)', { ...event, data: '[base64 data]' })
  } else {
    log('➡️', `broadcast:${event.type}`, { seq, event, sent })
  }
  return sent
}

function dispatchToWebhooks(event: ClientEvent): void {
  const body = JSON.stringify(event)
  for (const url of webhooks) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch((err) => console.warn(`webhook ${url} failed:`, (err as Error).message))
  }
}

function dismissPrompt(id: string): void {
  broadcast({ type: 'prompt_dismiss', id })
}

function resolvePrompt(event: PromptResponse): boolean {
  const waiter = promptWaiters.get(event.id)
  if (!waiter) return false
  promptWaiters.delete(event.id)
  dismissPrompt(event.id)
  waiter.resolve(event)
  return true
}

function waitForPrompt(prompt: PermissionRequest): Promise<PromptResponse | null> {
  broadcast(prompt)
  return new Promise((resolve) => {
    promptWaiters.set(prompt.id, { resolve })
    // Safety valve: auto-dismiss after 10 minutes so a crashed hook doesn't
    // leave a stale waiter that permanently blocks the prompt slot.
    setTimeout(() => {
      if (promptWaiters.delete(prompt.id)) {
        dismissPrompt(prompt.id)
        resolve(null)
      }
    }, 10 * 60 * 1000)
  })
}

// ---------------------------------------------------------------------------
// HTTP endpoints — agent-facing
// ---------------------------------------------------------------------------

/** Broadcast a single typed ServerEvent to all connected clients. */
app.post('/event', async (c) => {
  const event = (await c.req.json()) as ServerEvent

  if (event.type === 'commands') {
    commandsCache.set(event.agent ?? '__global__', event)
  }
  const sent = broadcast(event)
  return c.json({ sent })
})

/** Convenience: expand a plain string into message_start/text_delta/message_end. */
app.post('/send', async (c) => {
  const { message } = await c.req.json<{ message: string }>()
  log(' ', 'POST /send', message.slice(0, 120))
  let sent = 0
  for (const event of textMessage(message)) {
    sent += broadcast(event)
  }
  return c.json({ sent })
})

/** Broadcast a permission prompt and wait indefinitely for the first client response. */
app.post('/prompt/wait', async (c) => {
  const { prompt } = await c.req.json<{ prompt: PermissionRequest }>()
  log(' ', `POST /prompt/wait  id=${prompt.id} title="${prompt.title}"`)

  // If the hook process exits mid-wait (e.g. desktop native dialog was approved
  // and Claude Code killed the hook), the HTTP connection drops and the abort
  // signal fires. Cancel immediately so mobile doesn't linger.
  c.req.raw.signal.addEventListener('abort', () => {
    const waiter = promptWaiters.get(prompt.id)
    if (waiter) {
      promptWaiters.delete(prompt.id)
      waiter.resolve(null)
    }
    dismissPrompt(prompt.id)
  })

  const response = await waitForPrompt(prompt)
  if (response) {
    log('⬅️', `prompt/wait resolved  id=${prompt.id} choice=${response.choice}`)
  } else {
    log(' ', `prompt/wait aborted  id=${prompt.id}`)
  }
  return c.json({ response })
})

/**
 * Cancel a pending prompt. Dismisses it on all connected clients and resolves
 * any in-flight `/prompt/wait` waiter as null. Used by the Claude Code hook
 * when the desktop's native permission dialog was approved — we need to tell
 * the mobile client to take the prompt down.
 */
app.post('/prompt/cancel/:id', (c) => {
  const id = c.req.param('id')
  log(' ', `POST /prompt/cancel  id=${id}`)
  const waiter = promptWaiters.get(id)
  if (waiter) {
    promptWaiters.delete(id)
    waiter.resolve(null)
  }
  dismissPrompt(id)
  return c.json({ cancelled: !!waiter })
})

/**
 * Receive a DB dump from the mobile client and print it to the server console.
 * Triggered by the /view-db slash command in the chat screen.
 */
app.post('/db/dump', async (c) => {
  const { agents, itemCounts } = await c.req.json<{
    agents: Array<{
      id: string
      display_name: string
      last_status: string
      last_message_preview: string | null
      last_event_at: number | null
    }>
    itemCounts: Record<string, { messages: number; tools: number; prompts: number }>
  }>()

  log(' ', 'POST /db/dump')

  if (agents.length === 0) {
    console.log('\n[DB DUMP] No agents in database.\n')
    return c.json({ logged: true })
  }

  const rows = agents.map((a) => {
    const counts = itemCounts[a.id] ?? { messages: 0, tools: 0, prompts: 0 }
    return {
      id:          a.id,
      name:        a.display_name,
      status:      a.last_status,
      messages:    counts.messages,
      tools:       counts.tools,
      prompts:     counts.prompts,
      preview:     (a.last_message_preview ?? '').slice(0, 40) || '—',
    }
  })

  console.log('\n[DB DUMP]')
  console.table(rows)
  console.log('')

  return c.json({ logged: true })
})

/**
 * Receive a chat history dump from the mobile client and print it to the
 * server console. Triggered by the /view-chat-history slash command.
 * Pass with-tools on the mobile side to include tool rows.
 */
app.post('/chat/dump', async (c) => {
  const { chatId, items } = await c.req.json<{
    chatId: string
    items: Array<{
      kind: 'message' | 'tool'
      role?: string
      text?: string
      name?: string
      args?: Record<string, unknown>
      result?: unknown
      done: boolean
    }>
  }>()

  log(' ', `POST /chat/dump  chat=${chatId} items=${items.length}`)

  if (items.length === 0) {
    console.log(`\n[CHAT DUMP] No items for chat "${chatId}".\n`)
    return c.json({ logged: true })
  }

  const rows = items.map((it, i) => {
    if (it.kind === 'tool') {
      const argsStr = JSON.stringify(it.args ?? {})
      const preview = `${it.name}(${argsStr})`.slice(0, 100)
      return { '#': i + 1, role: '(tool)', content: preview, done: it.done ? '✓' : '…' }
    }
    return {
      '#': i + 1,
      role: it.role ?? '—',
      content: (it.text ?? '').replace(/\n/g, ' ').slice(0, 100) || '—',
      done: it.done ? '✓' : '…',
    }
  })

  console.log(`\n[CHAT DUMP] chat=${chatId}`)
  console.table(rows)
  console.log('')

  return c.json({ logged: true })
})

/**
 * Receive the last N messages from the mobile client and print them to the
 * server console. Triggered by the /view-last-n-msgs slash command.
 */
app.post('/last-messages/dump', async (c) => {
  const { chatId, messages } = await c.req.json<{
    chatId: string
    messages: Array<{
      id: string
      role: 'assistant' | 'user' | 'system'
      text: string
      done: boolean
    }>
  }>()

  log(' ', `POST /last-messages/dump  chat=${chatId} messages=${messages.length}`)

  if (messages.length === 0) {
    console.log(`\n[LAST MESSAGES] No messages for chat "${chatId}".\n`)
    return c.json({ logged: true })
  }

  console.log(`\n[LAST MESSAGES] chat=${chatId} (${messages.length} message${messages.length !== 1 ? 's' : ''})`)

  const rows = messages.map((msg, i) => ({
    '#': i + 1,
    role: msg.role,
    text: msg.text.replace(/\n/g, ' ').slice(0, 1000) || '—',
    done: msg.done ? '✓' : '…',
  }))
  console.table(rows)

  return c.json({ logged: true })
})

/** Connected client count — used by the simulator UI for status polling. */
app.get('/status', (c) => {
  const connected = [...clients].filter(ws => ws.readyState === WebSocket.OPEN).length
  // Not logged — polled every few seconds by the simulator; would flood output.
  return c.json({ clients: connected })
})

/**
 * Inject a prompt response directly — lets the simulator's "Simulate mobile
 * response" button resolve a live /prompt/wait without needing a real phone.
 */
app.post('/prompt/respond', async (c) => {
  const { id, choice } = await c.req.json<{ id: string; choice: string }>()
  log('⬅️', `POST /prompt/respond  id=${id} choice=${choice}`)
  const resolved = resolvePrompt({ type: 'prompt_response', id, choice })
  return c.json({ resolved })
})

/** Register a webhook URL to receive ClientEvents forwarded from the phone. */
app.post('/webhook', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  webhooks.add(url)
  log(' ', `POST /webhook registered  url=${url} total=${webhooks.size}`)
  return c.json({ registered: webhooks.size })
})

/** Deregister a webhook URL. */
app.delete('/webhook', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  webhooks.delete(url)
  log(' ', `DELETE /webhook removed  url=${url} total=${webhooks.size}`)
  return c.json({ registered: webhooks.size })
})

// ---------------------------------------------------------------------------
// WebSocket server — phone-facing
// ---------------------------------------------------------------------------

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`server listening on port ${info.port}`)
}) as HttpServer

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  clients.add(ws)
  log('✅', `ws:connect  total=${clients.size}`)

  // Replay cached commands so late-joining clients get the current command list
  // for every active agent without having to ask.
  replayCommandsTo(ws)

  ws.on('message', (raw) => {
    try {
      const event = JSON.parse(raw.toString()) as ClientEvent
      log('⬅️', `ws:${event.type}`, event)
      if (event.type === 'prompt_response') {
        resolvePrompt(event)
      } else if (event.type === 'get_commands') {
        // Client is explicitly requesting the current command list (e.g. after
        // a reconnect or before the agent has had a chance to broadcast).
        if (ws.readyState === WebSocket.OPEN) replayCommandsTo(ws)
      } else if (event.type === 'get_missed_events') {
        const after = event.after_seq
        const missed = eventBuffer.filter((e) => e.seq > after)
        log(' ', `ws:get_missed_events  after=${after} replaying=${missed.length}`)
        for (const entry of missed) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(entry))
          }
        }
      }
      dispatchToWebhooks(event)
    } catch {
      log(' ', 'ws:unparseable', raw.toString().slice(0, 200))
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    log('❌', `ws:disconnect  total=${clients.size}`)
  })
})
