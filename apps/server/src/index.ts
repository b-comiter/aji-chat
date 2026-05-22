import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientEvent, ServerEvent } from '@aji/protocol'
import { textMessage } from '@aji/protocol'

const app = new Hono()
const clients = new Set<WebSocket>()
const webhooks = new Set<string>()

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

// ---------------------------------------------------------------------------
// HTTP endpoints — agent-facing
// ---------------------------------------------------------------------------

/** Broadcast a single typed ServerEvent to all connected clients. */
app.post('/event', async (c) => {
  const event = (await c.req.json()) as ServerEvent
  const sent = broadcast(event)
  return c.json({ sent })
})

/** Convenience: expand a plain string into message_start/text_delta/message_end. */
app.post('/send', async (c) => {
  const { message } = await c.req.json<{ message: string }>()
  let sent = 0
  for (const event of textMessage(message)) {
    sent = broadcast(event)
  }
  return c.json({ sent })
})

/** Register a webhook URL to receive ClientEvents forwarded from the phone. */
app.post('/webhook', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  webhooks.add(url)
  console.log(`webhook registered: ${url} (total: ${webhooks.size})`)
  return c.json({ registered: webhooks.size })
})

/** Deregister a webhook URL. */
app.delete('/webhook', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  webhooks.delete(url)
  console.log(`webhook removed: ${url} (total: ${webhooks.size})`)
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
  console.log(`client connected (total: ${clients.size})`)

  ws.on('message', (raw) => {
    try {
      const event = JSON.parse(raw.toString()) as ClientEvent
      console.log('← client:', JSON.stringify(event))
      dispatchToWebhooks(event)
    } catch {
      console.warn('unparseable client frame:', raw.toString())
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`client disconnected (total: ${clients.size})`)
  })
})
