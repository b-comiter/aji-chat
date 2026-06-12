/**
 * Integration test: simulates a mobile user_message reaching the server.
 *
 * Opens a WebSocket to the server (exactly what the mobile app does) and sends
 * a user_message ClientEvent. If the channel bridge is running, it will receive
 * this via webhook and emit the channel notification to Claude Code.
 *
 * Use this to verify the full chain without needing a phone:
 *   Terminal 1: pnpm server
 *   Terminal 2: (Claude Code with bridge registered, or) pnpm channel:bridge
 *   Terminal 3: pnpm test:message "your message here"
 *
 * The second terminal should log: [aji-bridge] forwarding user_message → your message here
 */
import WebSocket from 'ws'

const SERVER_WS = process.env.AJI_SERVER_WS ?? 'ws://localhost:4000/ws'
const text = process.argv[2] ?? 'hello from simulated mobile'
const agent = process.argv[3] ?? 'claude-code'

const ws = new WebSocket(SERVER_WS)

ws.on('open', () => {
  const event = { type: 'user_message', text, agent }
  ws.send(JSON.stringify(event))
  console.log(`Sent: ${JSON.stringify(event)}`)
  setTimeout(() => {
    ws.close()
    process.exit(0)
  }, 500)
})

ws.on('error', (err) => {
  console.error('Connection failed — is the server running? (pnpm server)')
  console.error(err.message)
  process.exit(1)
})
