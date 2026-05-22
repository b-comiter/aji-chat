import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'
import type { ServerEvent } from '@aji/protocol'
import { textMessage } from '@aji/protocol'

const app = new Hono()
const clients = new Set<WebSocket>()

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

/**
 * Broadcast a single raw ServerEvent (used by the simulator and any future
 * agent adapter). Body must conform to the protocol package's ServerEvent
 * shape — we trust the caller for now.
 */
app.post('/event', async (c) => {
  const event = (await c.req.json()) as ServerEvent
  const sent = broadcast(event)
  return c.json({ sent })
})

/**
 * Convenience endpoint for plain-text messages. Expands into a complete
 * message_start / text_delta / message_end sequence.
 */
app.post('/send', async (c) => {
  const { message } = await c.req.json<{ message: string }>()
  let sent = 0
  for (const event of textMessage(message)) {
    sent = broadcast(event)
  }
  return c.json({ sent })
})

const server = serve({ fetch: app.fetch, port: 4000 }, (info) => {
  console.log(`server listening on port ${info.port}`)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wss = new WebSocketServer({ server: server as any, path: '/ws' })

wss.on('connection', (ws) => {
  clients.add(ws)
  console.log(`client connected (total: ${clients.size})`)
  ws.on('close', () => {
    clients.delete(ws)
    console.log(`client disconnected (total: ${clients.size})`)
  })
})
