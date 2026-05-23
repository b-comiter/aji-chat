import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientEvent, PermissionRequest, PromptResponse, ServerEvent } from '@aji/protocol'
import { textMessage } from '@aji/protocol'

const app = new Hono()
app.use('*', cors())
const clients = new Set<WebSocket>()
const webhooks = new Set<string>()
const promptWaiters = new Map<string, { resolve: (event: PromptResponse | null) => void; timer: ReturnType<typeof setTimeout> }>()

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

function log(direction: '→' | '←' | ' ', tag: string, detail?: unknown): void {
  const prefix = `[${ts()}] ${direction} ${tag}`
  if (detail === undefined) {
    console.log(prefix)
  } else if (typeof detail === 'string') {
    console.log(`${prefix}  ${detail}`)
  } else {
    console.log(`${prefix}  ${JSON.stringify(detail)}`)
  }
}

interface WaitForPromptBody {
  prompt: PermissionRequest
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

function broadcast(event: ServerEvent): number {
  const payload = JSON.stringify(event)
  let sent = 0
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload)
      sent += 1
    }
  }
  log('→', `broadcast:${event.type}`, { sent, event })
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
  clearTimeout(waiter.timer)
  promptWaiters.delete(event.id)
  dismissPrompt(event.id)
  waiter.resolve(event)
  return true
}

function waitForPrompt(prompt: PermissionRequest, timeoutMs: number): Promise<PromptResponse | null> {
  broadcast(prompt)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      promptWaiters.delete(prompt.id)
      dismissPrompt(prompt.id)
      resolve(null)
    }, timeoutMs)

    promptWaiters.set(prompt.id, { resolve, timer })
  })
}

// ---------------------------------------------------------------------------
// HTTP endpoints — agent-facing
// ---------------------------------------------------------------------------

/** Broadcast a single typed ServerEvent to all connected clients. */
app.post('/event', async (c) => {
  const event = (await c.req.json()) as ServerEvent
  log(' ', `POST /event  type=${event.type}`)
  const sent = broadcast(event)
  return c.json({ sent })
})

/** Convenience: expand a plain string into message_start/text_delta/message_end. */
app.post('/send', async (c) => {
  const { message } = await c.req.json<{ message: string }>()
  log(' ', 'POST /send', message.slice(0, 120))
  let sent = 0
  for (const event of textMessage(message)) {
    sent = broadcast(event)
  }
  return c.json({ sent })
})

/** Broadcast a permission prompt and wait for the first client response. */
app.post('/prompt/wait', async (c) => {
  const { prompt, timeoutMs = 15000 } = await c.req.json<WaitForPromptBody>()
  log(' ', `POST /prompt/wait  id=${prompt.id} timeout=${timeoutMs}ms title="${prompt.title}"`)

  // If the hook process exits mid-wait (e.g. desktop native dialog was
  // approved and Claude Code killed the hook), the HTTP connection drops and
  // the abort signal fires. Cancel immediately so mobile doesn't linger.
  c.req.raw.signal.addEventListener('abort', () => {
    const waiter = promptWaiters.get(prompt.id)
    if (waiter) {
      clearTimeout(waiter.timer)
      promptWaiters.delete(prompt.id)
      waiter.resolve(null)
    }
    dismissPrompt(prompt.id)
  })

  const response = await waitForPrompt(prompt, timeoutMs)
  if (response) {
    log('←', `prompt/wait resolved  id=${prompt.id} choice=${response.choice}`)
  } else {
    log(' ', `prompt/wait timed out or aborted  id=${prompt.id}`)
  }
  return c.json({ response, timedOut: response === null })
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
    clearTimeout(waiter.timer)
    promptWaiters.delete(id)
    waiter.resolve(null)
  }
  dismissPrompt(id)
  return c.json({ cancelled: !!waiter })
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
  log('←', `POST /prompt/respond  id=${id} choice=${choice}`)
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

const server = serve({ fetch: app.fetch, port: 4000 }, (info) => {
  console.log(`server listening on port ${info.port}`)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wss = new WebSocketServer({ server: server as any, path: '/ws' })

wss.on('connection', (ws) => {
  clients.add(ws)
  log(' ', `ws:connect  total=${clients.size}`)

  ws.on('message', (raw) => {
    try {
      const event = JSON.parse(raw.toString()) as ClientEvent
      log('←', `ws:${event.type}`, event)
      if (event.type === 'prompt_response') resolvePrompt(event)
      dispatchToWebhooks(event)
    } catch {
      log(' ', 'ws:unparseable', raw.toString().slice(0, 200))
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    log(' ', `ws:disconnect  total=${clients.size}`)
  })
})
