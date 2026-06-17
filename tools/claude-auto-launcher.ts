/**
 * aji-chat → Claude Code AUTO-LAUNCHER (spawn-on-demand).
 *
 * Complements the inbound channel bridge (tools/claude-channel-bridge.ts). The
 * bridge can only inject a phone message into a Claude Code session that is
 * ALREADY running. This launcher closes that gap: when a message arrives from
 * the phone and no session is alive, it opens a visible Terminal.app window
 * running Claude Code with the message as the opening prompt. Everything after
 * that flows through the channel bridge as usual.
 *
 * It is a plain WEBHOOK SUBSCRIBER, not an MCP server — the same adapter pattern
 * the bridge uses. It requires NO server changes (the aji-chat server stays a
 * dumb router): it self-registers a webhook against the running server and
 * reacts to the ClientEvents the server forwards.
 *
 * Data path:
 *   phone → WS /ws → aji-chat server → POST (webhook) → this launcher
 *        → osascript → Terminal.app → `claude … "<your message>"`
 *
 * Interplay with the bridge (no double-delivery):
 *   • No session running → only THIS launcher has a live webhook, so it alone
 *     receives the message and spawns a session with it as the initial prompt.
 *   • Session already running → the server forwards to BOTH the session's bridge
 *     and this launcher. The bridge injects via the channel; the launcher detects
 *     the live session (pgrep) and does nothing. The message is delivered once.
 *
 * Env:
 *   AJI_SERVER       base URL of the aji-chat server   (default http://localhost:4000)
 *   AJI_AGENT        which server this represents       (default claude-code)
 *   AJI_PROJECT_DIR  cwd for the spawned session        (default process.cwd())
 *   AJI_CLAUDE_BIN   claude executable                  (default "claude", resolved on PATH)
 *   AJI_LAUNCH_DRYRUN=1  log the spawn instead of opening Terminal (used by the smoke test)
 */
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { execFile } from 'node:child_process'
import type { ClientEvent, UserMessage } from '@aji/protocol'

const AJI_SERVER = (process.env.AJI_SERVER ?? 'http://localhost:4000').replace(/\/$/, '')
const AJI_AGENT = process.env.AJI_AGENT ?? 'claude-code'
const ACCESS_TOKEN = process.env.AJI_ACCESS_TOKEN?.trim()
const PROJECT_DIR = process.env.AJI_PROJECT_DIR ?? process.cwd()
const CLAUDE_BIN = process.env.AJI_CLAUDE_BIN ?? 'claude'
const DRY_RUN = process.env.AJI_LAUNCH_DRYRUN === '1'

// The launch flag that loads our custom channel.
const CHANNEL_FLAG = '--dangerously-load-development-channels server:aji-chat'

// Fingerprint for detecting an already-running session. Must NOT start with a
// dash — pgrep would parse a leading "--…" as its own options and error out
// (silently making detection always-false). The dash-free tail is still unique
// enough that nothing else on the machine carries it.
const SESSION_PATTERN = 'dangerously-load-development-channels server:aji-chat'

function log(...args: unknown[]): void {
  console.error('[aji-launcher]', ...args)
}

/**
 * Pure routing predicate (exported for tests): should this client event trigger
 * a launch? Mirrors the bridge's `shouldForward` — only a `user_message` for our
 * agent (or an agent-less message from older mobile builds) qualifies.
 */
export function shouldLaunch(
  event: ClientEvent,
  serverId: string,
): event is UserMessage {
  if (event.type !== 'user_message') return false
  return event.serverId === undefined || event.serverId === serverId
}

/**
 * Build the shell command run inside the Terminal window.
 *
 * The initial prompt is passed via `"$(cat <file>)"` rather than inlined: command
 * substitution inside double quotes is not re-parsed by the shell, so arbitrary
 * message text (quotes, spaces, newlines) survives intact without bespoke escaping.
 *
 * The `--` before the prompt is REQUIRED: `--dangerously-load-development-channels`
 * is variadic and would otherwise swallow the prompt as an (untagged) channel
 * entry — `claude` then exits with "entries must be tagged". `--` ends option
 * parsing so the prompt lands as the positional `[prompt]`, and also protects a
 * message that happens to start with `-`.
 */
export function buildLaunchCommand(opts: {
  projectDir: string
  claudeBin: string
  promptFile: string
}): string {
  return `cd ${JSON.stringify(opts.projectDir)} && ${opts.claudeBin} ${CHANNEL_FLAG} -- "$(cat ${JSON.stringify(opts.promptFile)})"`
}

/**
 * Wrap a shell command in an AppleScript that opens a visible Terminal.app
 * window and runs it. Escapes backslashes then double quotes so the command
 * survives as an AppleScript string literal.
 */
export function buildTerminalAppleScript(shellCommand: string): string {
  const escaped = shellCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `tell application "Terminal"\n  activate\n  do script "${escaped}"\nend tell`
}

/** True when a Claude Code session with our channel flag is already running. */
function sessionRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    // pgrep exits 1 (→ err) when there is no match. Match the fingerprint, but
    // exclude the transient `osascript` process whose argv also contains it
    // mid-spawn.
    execFile('pgrep', ['-fl', SESSION_PATTERN], (err, stdout) => {
      if (err || !stdout) return resolve(false)
      const live = stdout
        .split('\n')
        .filter((line) => line.trim() && !/osascript/.test(line))
      resolve(live.length > 0)
    })
  })
}

// Suppress duplicate spawns while a freshly-launched session boots and becomes
// visible to pgrep. Cleared after the boot window elapses.
let spawning = false
const SPAWN_LOCK_MS = 30_000

function launchSession(text: string): void {
  spawning = true
  setTimeout(() => { spawning = false }, SPAWN_LOCK_MS)

  const promptFile = path.join(os.tmpdir(), `aji-cc-initial-${Date.now()}.txt`)
  try {
    fs.writeFileSync(promptFile, text, 'utf8')
  } catch (err) {
    log('failed to stage prompt file:', (err as Error).message)
    spawning = false
    return
  }

  const shellCommand = buildLaunchCommand({ projectDir: PROJECT_DIR, claudeBin: CLAUDE_BIN, promptFile })

  if (DRY_RUN) {
    log('DRYRUN would launch →', text.slice(0, 80))
    return
  }

  const script = buildTerminalAppleScript(shellCommand)
  execFile('osascript', ['-e', script], (err) => {
    if (err) {
      log('osascript failed:', err.message)
      spawning = false
    } else {
      log('launched Terminal session with initial prompt:', text.slice(0, 80))
    }
  })
}

async function handleMessage(event: ClientEvent): Promise<void> {
  if (!shouldLaunch(event, AJI_AGENT)) return
  if (spawning) {
    log('spawn already in progress — skipping')
    return
  }
  if (await sessionRunning()) {
    log('session already running — channel bridge will deliver')
    return
  }
  log('no live session — launching for:', event.text.slice(0, 80))
  launchSession(event.text)
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
      void handleMessage(JSON.parse(body) as ClientEvent)
    } catch {
      /* ignore malformed payloads */
    }
  })
})

// ---------------------------------------------------------------------------
// Webhook (de)registration against the running aji-chat server. Mirrors the
// bridge: re-register every 30 s so a server restart re-connects automatically.
// ---------------------------------------------------------------------------
let webhookUrl: string | null = null
let webhookPort: number | null = null
let reregisterTimer: ReturnType<typeof setInterval> | null = null

async function registerWebhook(port: number): Promise<void> {
  webhookUrl = `http://localhost:${port}/`
  webhookPort = port
  try {
    await fetch(`${AJI_SERVER}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ACCESS_TOKEN ? { 'X-Aji-Token': ACCESS_TOKEN } : {}) },
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

async function main(): Promise<void> {
  httpServer.listen(0, '127.0.0.1', () => {
    const addr = httpServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    log('webhook listener on port', port)
    void registerWebhook(port)
    reregisterTimer = setInterval(() => {
      if (webhookPort !== null) void registerWebhook(webhookPort)
    }, 30_000)
  })
  log('auto-launcher started; agent =', AJI_AGENT, 'server =', AJI_SERVER, 'projectDir =', PROJECT_DIR)
}

// Only run the listener when executed directly (so tests can import the pure
// helpers without spawning anything).
if (process.env.AJI_LAUNCHER_TEST !== '1') {
  main().catch((err) => log('fatal:', (err as Error).message))
}
