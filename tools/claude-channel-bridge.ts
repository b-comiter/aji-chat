/**
 * aji-chat → Claude Code channel bridge (INBOUND direction).
 *
 * Complements the outbound hook (tools/claude_code_integration/claude-aji-chat-hook.ts). Where the hook
 * pushes Claude's activity OUT to mobile, this bridge pushes messages typed on
 * mobile INTO a running Claude Code session.
 *
 * Mechanism — Claude Code "channels" (https://code.claude.com/docs/en/channels.md):
 *   Claude Code spawns this file as a stdio MCP server. When the user sends a
 *   message from the phone, the aji-chat server forwards it here (over the
 *   existing webhook mechanism — no server changes), and we emit a
 *   `notifications/claude/channel` notification. Claude Code injects the body
 *   into the live session as `<channel source="aji-chat">…</channel>`.
 *
 * Why this is cheap on tokens: it's push, not poll. A quiet session costs zero
 * tokens — nothing is injected until an actual message arrives.
 *
 * Data path:
 *   phone → WS /ws → aji-chat server → POST (webhook) → this bridge
 *        → notifications/claude/channel → Claude Code session
 *
 * IMPORTANT: stdout is the MCP JSON-RPC stream. NEVER write logs to stdout —
 * only stderr (console.error) — or the transport will be corrupted.
 *
 * Env:
 *   AJI_SERVER  base URL of the aji-chat server    (default http://localhost:4000)
 *   AJI_AGENT   which server this bridge represents (default claude-code)
 */
import * as http from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js'
import type { ClientEvent, UserMessage } from '@aji/protocol'

const AJI_SERVER = (process.env.AJI_SERVER ?? 'http://localhost:4000').replace(/\/$/, '')
const AJI_AGENT = process.env.AJI_AGENT ?? 'claude-code'
const ACCESS_TOKEN = process.env.AJI_ACCESS_TOKEN?.trim()

// stdout belongs to the MCP transport — log only to stderr.
function log(...args: unknown[]): void {
  console.error('[aji-bridge]', ...args)
}

/**
 * Pure routing predicate (exported for tests): does this client event belong to
 * the server this bridge represents? A `user_message` with no `serverId` is
 * treated as a match so older mobile builds (pre-serverId-field) still reach the
 * session.
 */
export function shouldForward(
  event: ClientEvent,
  serverId: string,
): event is UserMessage {
  if (event.type !== 'user_message') return false
  return event.serverId === undefined || event.serverId === serverId
}

const server = new Server(
  { name: 'aji-chat', version: '0.1.0' },
  {
    // REQUIRED: declaring this capability is what makes Claude Code register a
    // channel notification listener. Without it the MCP server still "connects"
    // (shows up in `claude mcp list`), but every notification is dropped silently.
    capabilities: { experimental: { 'claude/channel': {} } },
    // Added to Claude's system prompt so it knows how to treat these events.
    instructions:
      'Messages from the user\'s phone (aji-chat) arrive as ' +
      '<channel source="aji-chat">…</channel>. Treat the body as a message the ' +
      'user is sending you directly — read it and respond as if they typed it in ' +
      'the terminal. This is a one-way channel: do not call a tool to reply; your ' +
      'normal response already reaches their phone.',
  },
)

/**
 * Emit the Claude Code channel notification carrying a mobile message.
 * The <channel> tag's `source` attribute is set automatically from this server's
 * configured name ("aji-chat"), so we don't pass it in meta.
 */
async function pushToChannel(text: string): Promise<void> {
  try {
    await server.notification({
      method: 'notifications/claude/channel',
      params: { content: text },
      // Custom Claude Code notification method — not in the base ServerNotification
      // union, so cast through unknown.
    } as unknown as ServerNotification)
  } catch (err) {
    log('channel notification failed:', (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Webhook receiver — the aji-chat server POSTs every ClientEvent here.
// ---------------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
    try {
      const event = JSON.parse(body) as ClientEvent
      if (shouldForward(event, AJI_AGENT)) {
        log('forwarding user_message →', event.text.slice(0, 80))
        void pushToChannel(event.text)
      }
    } catch {
      /* ignore malformed payloads */
    }
  })
})

// ---------------------------------------------------------------------------
// Webhook (de)registration against the running aji-chat server.
// ---------------------------------------------------------------------------
let webhookUrl: string | null = null
let webhookPort: number | null = null
// Re-register every 30 s so a server restart re-connects automatically.
// The server's webhook set is in-memory; any restart wipes it silently.
let reregisterTimer: ReturnType<typeof setInterval> | null = null

async function registerWebhook(port: number): Promise<void> {
  webhookUrl = `http://localhost:${port}/`
  webhookPort = port
  try {
    await fetch(`${AJI_SERVER}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ACCESS_TOKEN ? { 'X-Aji-Token': ACCESS_TOKEN } : {}) },
      // Scope the webhook to this server so the aji-chat server only forwards
      // events targeting claude-code (not messages meant for other agents).
      body: JSON.stringify({ url: webhookUrl, serverId: AJI_AGENT }),
    })
    log('registered webhook', webhookUrl, 'with', AJI_SERVER)
  } catch (err) {
    log('webhook registration failed (server down? will retry):', (err as Error).message)
  }
}

async function deregisterWebhook(): Promise<void> {
  if (!webhookUrl) return
  try {
    await fetch(`${AJI_SERVER}/webhook`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(ACCESS_TOKEN ? { 'X-Aji-Token': ACCESS_TOKEN } : {}) },
      body: JSON.stringify({ url: webhookUrl }),
    })
    log('deregistered webhook', webhookUrl)
  } catch {
    /* best effort on shutdown */
  }
}

function shutdown(): void {
  if (reregisterTimer !== null) clearInterval(reregisterTimer)
  void deregisterWebhook().finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.stdin.on('end', shutdown)

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
  httpServer.listen(0, '127.0.0.1', () => {
    const addr = httpServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    log('webhook listener on port', port)
    void registerWebhook(port)
    reregisterTimer = setInterval(() => {
      if (webhookPort !== null) void registerWebhook(webhookPort)
    }, 30_000)
  })
  log('bridge started; agent =', AJI_AGENT, 'server =', AJI_SERVER)
}

// Only run the server when executed directly (so tests can import shouldForward
// without spawning the transport).
if (process.env.AJI_BRIDGE_TEST !== '1') {
  main().catch((err) => log('fatal:', (err as Error).message))
}
