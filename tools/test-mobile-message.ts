/**
 * Integration test: simulates a mobile user_message reaching the server.
 *
 * Opens a WebSocket to the server (exactly what the mobile app does) and sends a
 * user_message ClientEvent. If a channel bridge is registered for the target
 * serverId, the server forwards this via webhook and Claude Code receives the
 * channel notification.
 *
 * Use this to verify the full chain without a phone:
 *   Terminal 1: pnpm server
 *   Terminal 2: a Claude Code session with the channel loaded (or pnpm channel:bridge)
 *   Terminal 3: pnpm test:message "your message here" [serverId]
 *
 * The bridge terminal should log: [aji-bridge] forwarding user_message → your message
 *
 * Uses Node's built-in global WebSocket (Node 21+) — no dependencies.
 */
const SERVER_WS = process.env.AJI_SERVER_WS ?? 'ws://localhost:4000/ws'
const text = process.argv[2] ?? 'hello from simulated mobile'
const serverId = process.argv[3] ?? 'claude-code'

const ws = new WebSocket(SERVER_WS)

ws.addEventListener('open', () => {
  const event = { type: 'user_message', text, serverId, channel: 'general' }
  ws.send(JSON.stringify(event))
  console.log(`Sent: ${JSON.stringify(event)}`)
  setTimeout(() => {
    ws.close()
    process.exit(0)
  }, 500)
})

ws.addEventListener('error', (err) => {
  console.error('Connection failed — is the server running? (pnpm server)')
  console.error((err as { message?: string }).message ?? String(err))
  process.exit(1)
})
