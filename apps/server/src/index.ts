import type { Server as HttpServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientEvent, Commands, PermissionRequest, PromptResponse, ServerEvent, ServerInfo } from '@aji/protocol'
import { textMessage } from '@aji/protocol'
import { shouldDeliverToWebhook } from './routing'
import {
  loadChannels, registerChannel, deregisterChannel, channelsEvent, allServerIds,
} from './channels'
import {
  loadAgents, saveAgents, bearerToken, agentIdForToken, getAgentRecord, hasToken, mintAgent,
} from './agents'
import { loadJson, saveJson } from './persist'
import { loadPushState, registerPushToken, setServerMuted, observeForPush } from './push'
import { selectMissedEvents } from './replay'
import { registerDebugRoutes } from './debugRoutes'

const PORT = Number(process.env.AJI_PORT) || 4000
const ACCESS_TOKEN = process.env.AJI_ACCESS_TOKEN?.trim() || undefined

const app = new Hono()
app.use('*', cors())

app.use('*', async (c, next) => {
  if (!ACCESS_TOKEN || c.req.path === '/status') return next()
  if (c.req.header('x-aji-token') !== ACCESS_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return next()
})

const clients = new Set<WebSocket>()
const webhooks = new Map<string, string | undefined>()
const promptWaiters = new Map<string, { resolve: (event: PromptResponse | null) => void }>()

// ---------------------------------------------------------------------------
// Server info + commands caches
// ---------------------------------------------------------------------------

// Latest commands per server — replayed to every new WS client on connect.
const commandsCache = new Map<string, Commands>()

// Latest server_info per server — persisted so name + mono-channel flag survive
// an aji-chat-server restart without waiting for the agent to reconnect.
const SERVER_INFO_FILE = process.env.AJI_DATA_DIR
  ? join(process.env.AJI_DATA_DIR, 'server_info.json')
  : join(homedir(), '.aji-chat', 'server_info.json')
const serverInfoCache = new Map<string, ServerInfo>()

function loadServerInfo(): void {
  const obj = loadJson<Record<string, ServerInfo>>(SERVER_INFO_FILE)
  if (obj) for (const [serverId, info] of Object.entries(obj)) serverInfoCache.set(serverId, info)
}
function saveServerInfo(): void {
  const obj: Record<string, ServerInfo> = {}
  for (const [serverId, info] of serverInfoCache) obj[serverId] = info
  saveJson(SERVER_INFO_FILE, obj)
}

// Ring buffer of recent events for offline-reconnect replay.
const MAX_BUFFER = 500
const eventBuffer: Array<{ seq: number; event: ServerEvent }> = []
let nextSeq = 0

// Per-process boot id, stamped on every envelope. The ring buffer + seq counter
// are in-memory, so a restart resets `seq` to 0 while clients still hold a high
// persisted cursor. Clients compare this epoch to detect the restart and reset
// their cursor (see WebSocketContext); on the first reconnect the server also
// replays the whole buffer (see selectMissedEvents) so nothing is dropped.
const EPOCH = Date.now()

/** Wire envelope for a buffered event — carries the seq cursor + boot epoch. */
function envelope(seq: number, event: ServerEvent): string {
  return JSON.stringify({ seq, epoch: EPOCH, event })
}

// Load persisted state at startup.
loadAgents()
loadChannels()
loadServerInfo()
loadPushState()

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

/**
 * Dedicated, easy-to-grep line for an incoming approval prompt. Prints only the
 * protocol-level fields (id, title, channel, message, options) — the server is a
 * dumb router, so it stays out of any agent-specific encoding of `message`.
 */
function logPermissionRequest(event: PermissionRequest): void {
  log('➡️', `permission_request  id=${event.id} channel=${event.channel ?? '-'} title="${event.title}"`)
  log(' ', `  options: ${event.options.map((o) => o.id).join(', ') || '(none)'}`)
  log(' ', `  message: ${event.message.slice(0, 500) || '(empty)'}`)
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

function bufferAndSend(ws: WebSocket, event: ServerEvent): void {
  const seq = nextSeq++
  eventBuffer.push({ seq, event })
  if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift()
  ws.send(envelope(seq, event))
}

function replayCommandsTo(ws: WebSocket): void {
  for (const cached of commandsCache.values()) bufferAndSend(ws, cached)
}

function replayServerInfoTo(ws: WebSocket): void {
  for (const cached of serverInfoCache.values()) bufferAndSend(ws, cached)
}

function replayChannelsTo(ws: WebSocket): void {
  for (const serverId of allServerIds()) bufferAndSend(ws, channelsEvent(serverId))
}

function broadcast(event: ServerEvent): void {
  const seq = nextSeq++
  eventBuffer.push({ seq, event })
  if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift()

  const payload = envelope(seq, event)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload)
  }

  // Feed every event to the push module — it accumulates streamed text and
  // decides what (if anything) to deliver out-of-band. Synchronous + isolated:
  // it never blocks or breaks the WS broadcast. Only live broadcasts are
  // observed; reconnect replay goes through bufferAndSend/ws.send directly, so
  // the user isn't re-alerted on reconnect.
  const pushServerId = 'serverId' in event ? event.serverId : undefined
  observeForPush(event, pushServerId ? serverInfoCache.get(pushServerId)?.displayName : undefined)

  if (event.type === 'file') {
    log(' ', '(file event data omitted)', { ...event, data: '[base64 data]' })
  } else if (event.type === 'commands') {
    log(' ', '(commands event data omitted)', { ...event, commands: '[...]' })
  } else {
    log('➡️', event.type, { seq, event })
  }
}

function dispatchToWebhooks(event: ClientEvent): void {
  const body = JSON.stringify(event)
  const target = 'serverId' in event ? event.serverId : undefined
  for (const [url, serverId] of webhooks) {
    if (!shouldDeliverToWebhook(serverId, target)) continue
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

  const agentId = agentIdForToken(bearerToken(c))
  if (agentId) (event as { agentId?: string }).agentId = agentId

  if (event.type === 'commands') {
    commandsCache.set(event.serverId ?? '__global__', event)
  } else if (event.type === 'server_info') {
    serverInfoCache.set(event.serverId, event)
    saveServerInfo()
  } else if (event.type === 'permission_request') {
    logPermissionRequest(event)
  }
  broadcast(event)
  return c.json({ ok: true })
})

/**
 * Agent registration / token minting. No (or unknown) bearer token → mint a new
 * { agentId, token } and persist it. Known token → return the existing agentId.
 * Optional `{ name }` updates the display name.
 */
app.post('/agent/register', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }))
  const token = bearerToken(c)

  if (token && hasToken(token)) {
    const rec = getAgentRecord(token)!
    rec.lastSeen = Date.now()
    if (body.name) rec.name = body.name
    saveAgents()
    log(' ', `agent re-register agentId=${rec.agentId}`)
    return c.json({ agentId: rec.agentId })
  }

  const { token: newToken, agentId } = mintAgent(body.name ?? 'agent')
  log(' ', `agent minted agentId=${agentId} name=${body.name ?? 'agent'}`)
  return c.json({ agentId, token: newToken })
})

/**
 * Convenience: expand a plain string into message_start/text_delta/message_end.
 * Optional `serverId` and `channel` route the message to a specific conversation.
 */
app.post('/send', async (c) => {
  const { message, serverId, channel } = await c.req.json<{
    message: string
    serverId?: string
    channel?: string
  }>()
  log(' ', 'POST /send', `serverId=${serverId ?? '-'} channel=${channel ?? '-'} ${message.slice(0, 100)}`)
  const agentId = agentIdForToken(bearerToken(c))
  for (const event of textMessage(message, 'assistant', undefined, { serverId, channel })) {
    if (agentId) (event as { agentId?: string }).agentId = agentId
    broadcast(event)
  }
  return c.json({ ok: true })
})

/** Broadcast a permission prompt and wait indefinitely for the first client response. */
app.post('/prompt/wait', async (c) => {
  const { prompt } = await c.req.json<{ prompt: PermissionRequest }>()
  log(' ', `POST /prompt/wait  id=${prompt.id} title="${prompt.title}"`)

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
 * any in-flight `/prompt/wait` waiter as null.
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

registerDebugRoutes(app, log)

/** Channel registry for a server — agents call this to discover available channels. */
app.get('/channels', (c) => {
  const serverId = c.req.query('serverId')
  if (!serverId) return c.json({ error: 'serverId query param required' }, 400)
  return c.json({ serverId, channels: channelsEvent(serverId).channels })
})

/** Connected client count — used by the simulator UI for status polling. */
app.get('/status', (c) => {
  const connected = [...clients].filter(ws => ws.readyState === WebSocket.OPEN).length
  return c.json({ clients: connected })
})

/** Inject a prompt response directly — lets the simulator resolve a live /prompt/wait. */
app.post('/prompt/respond', async (c) => {
  const { id, choice } = await c.req.json<{ id: string; choice: string }>()
  log('⬅️', `POST /prompt/respond  id=${id} choice=${choice}`)
  const resolved = resolvePrompt({ type: 'prompt_response', id, choice })
  return c.json({ resolved })
})

/** Register a webhook URL to receive ClientEvents forwarded from the phone. */
app.post('/webhook', async (c) => {
  const { url, serverId } = await c.req.json<{ url: string; serverId?: string }>()
  webhooks.set(url, serverId)
  log(' ', `POST /webhook registered  url=${url} serverId=${serverId ?? '*'} total=${webhooks.size}`)
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

wss.on('connection', (ws, request) => {
  if (ACCESS_TOKEN) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.searchParams.get('token') !== ACCESS_TOKEN) {
      ws.close(4401, 'Unauthorized')
      return
    }
  }

  clients.add(ws)
  log('✅', `ws:connect  total=${clients.size}`)

  replayCommandsTo(ws)
  replayServerInfoTo(ws)
  replayChannelsTo(ws)

  ws.on('message', (raw) => {
    try {
      const event = JSON.parse(raw.toString()) as ClientEvent
      log('⬅️', `ws:${event.type}`, event)
      if (event.type === 'prompt_response') {
        resolvePrompt(event)
      } else if (event.type === 'get_commands') {
        if (ws.readyState === WebSocket.OPEN) replayCommandsTo(ws)
      } else if (event.type === 'create_channel') {
        registerChannel(event.serverId, event.channel, event.displayName)
        broadcast(channelsEvent(event.serverId))
      } else if (event.type === 'delete_channel') {
        deregisterChannel(event.serverId, event.channel)
        broadcast(channelsEvent(event.serverId))
      } else if (event.type === 'get_missed_events') {
        const after = event.after_seq
        // Restart-aware: a cursor ahead of our seq counter means the client is
        // from a previous instance, so replay the whole buffer rather than
        // filtering everything out (see selectMissedEvents).
        const missed = selectMissedEvents(eventBuffer, after, nextSeq)
        const restarted = after >= nextSeq
        log(' ', `ws:get_missed_events  after=${after} replaying=${missed.length}${restarted ? ' (server restart — full replay)' : ''}`)
        for (const entry of missed) {
          if (ws.readyState === WebSocket.OPEN) ws.send(envelope(entry.seq, entry.event))
        }
      } else if (event.type === 'register_push') {
        if (registerPushToken(event.token)) {
          log(' ', `ws:register_push  ${event.platform ?? '-'} token=…${event.token.slice(-12)}`)
        }
      } else if (event.type === 'set_mute') {
        setServerMuted(event.serverId, event.muted)
        log(' ', `ws:set_mute  serverId=${event.serverId} muted=${event.muted}`)
      }

      // register_push / set_mute are infra (the phone configuring its own
      // delivery) — not agent-facing messages, so they're never forwarded.
      if (event.type !== 'register_push' && event.type !== 'set_mute') {
        dispatchToWebhooks(event)
      }
    } catch {
      log(' ', 'ws:unparseable', raw.toString().slice(0, 200))
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    log('❌', `ws:disconnect  total=${clients.size}`)
  })
})
