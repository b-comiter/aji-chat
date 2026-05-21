import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket } from 'ws'

const app = new Hono()
const clients = new Set<WebSocket>()

app.post('/send', async (c) => {
  const { message } = await c.req.json<{ message: string }>()
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ message }))
    }
  }
  return c.json({ sent: clients.size })
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
