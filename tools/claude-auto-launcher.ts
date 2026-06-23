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
 *        → tmux (detached `claude … "<your message>"`, dev-channel warning
 *          auto-accepted via send-keys) → osascript attaches a visible Terminal
 *
 * Requires tmux (`brew install tmux`): it lets us programmatically dismiss
 * Claude Code's interactive dev-channels warning while keeping the session
 * visible/attachable on the Mac.
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
const TMUX_BIN = process.env.AJI_TMUX_BIN ?? 'tmux'
const TMUX_SESSION = process.env.AJI_TMUX_SESSION ?? 'aji-cc'
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

  const stamp = Date.now()
  const promptFile = path.join(os.tmpdir(), `aji-cc-initial-${stamp}.txt`)
  const scriptFile = path.join(os.tmpdir(), `aji-cc-launch-${stamp}.sh`)
  const shellCommand = buildLaunchCommand({ projectDir: PROJECT_DIR, claudeBin: CLAUDE_BIN, promptFile })
  try {
    fs.writeFileSync(promptFile, text, 'utf8')
    // The claude command runs from a script file so its quoting/`$(cat …)` survive
    // intact through tmux + osascript instead of being escaped three times over.
    fs.writeFileSync(scriptFile, `#!/bin/zsh -l\n${shellCommand}\n`, 'utf8')
  } catch (err) {
    log('failed to stage launch files:', (err as Error).message)
    spawning = false
    return
  }

  if (DRY_RUN) {
    log('DRYRUN would launch via tmux →', text.slice(0, 80))
    return
  }

  // Clear any stale same-named session (only reached when no live session exists),
  // then start the claude command detached inside tmux.
  execFile(TMUX_BIN, ['kill-session', '-t', TMUX_SESSION], () => {
    execFile(
      TMUX_BIN,
      ['new-session', '-d', '-s', TMUX_SESSION, '-x', '220', '-y', '50', `zsh -l ${scriptFile}`],
      (err) => {
        if (err) {
          log('tmux new-session failed:', err.message)
          spawning = false
          return
        }
        log('tmux session started; initial prompt:', text.slice(0, 80))
        autoAcceptDevChannelWarning()
        openVisibleTerminal()
      },
    )
  })
}

// The --dangerously-load-development-channels flag shows an interactive warning
// ("I am using this for local development") that blocks startup. Poll the pane
// for it and press Enter (option 1 is preselected) so the session boots
// unattended. Gives up after ~15s if it never appears.
function autoAcceptDevChannelWarning(): void {
  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    execFile(TMUX_BIN, ['capture-pane', '-p', '-t', TMUX_SESSION], (err, stdout) => {
      if (err) { clearInterval(timer); return } // session gone
      if (stdout.includes('Loading development channels')) {
        clearInterval(timer)
        execFile(TMUX_BIN, ['send-keys', '-t', TMUX_SESSION, 'Enter'], () => {})
        log('auto-accepted dev-channels warning')
      } else if (attempts >= 30) {
        clearInterval(timer)
      }
    })
  }, 500)
}

// Open a visible Terminal.app window attached to the tmux session so the user can
// watch and take over the running Claude Code session on their Mac. `attach -d`
// detaches any other (including stale/phantom) client so this window takes over.
function openVisibleTerminal(): void {
  const script = buildTerminalAppleScript(`${TMUX_BIN} attach -d -t ${TMUX_SESSION}`)
  execFile('osascript', ['-e', script], (err) => {
    if (err) log('osascript attach failed:', err.message)
  })
}

async function handleMessage(event: ClientEvent): Promise<void> {
  if (!shouldLaunch(event, AJI_AGENT)) return
  if (spawning) {
    log('spawn already in progress — skipping')
    return
  }
  if (await sessionRunning()) {
    // A channel session is live, but closing a tmux-backed Terminal only DETACHES
    // it (claude keeps running) — and a window that closed abnormally can leave a
    // stale "attached" client tmux never cleaned up. If there's no LIVE window,
    // re-open one (attach -d kicks any stale client); otherwise defer to the bridge.
    if (await tmuxSessionNeedsWindow()) {
      log('session running with no live window — reopening Terminal')
      openVisibleTerminal()
    } else {
      log('session already running — channel bridge will deliver')
    }
    return
  }
  log('no live session — launching for:', event.text.slice(0, 80))
  launchSession(event.text)
}

// True when our tmux session exists but has no *live* attached terminal: either
// no clients at all, or only stale/phantom clients whose tty has no live process
// (a Terminal window that closed without tmux noticing).
function tmuxSessionNeedsWindow(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(TMUX_BIN, ['has-session', '-t', TMUX_SESSION], (hasErr) => {
      if (hasErr) return resolve(false) // not our tmux session (or none) → caller spawns
      execFile(TMUX_BIN, ['list-clients', '-t', TMUX_SESSION, '-F', '#{client_tty}'], (lcErr, stdout) => {
        if (lcErr) return resolve(true)
        const ttys = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
        if (ttys.length === 0) return resolve(true) // detached
        // Resolve true (needs window) only if NONE of the client ttys has a live process.
        let pending = ttys.length
        let anyLive = false
        for (const tty of ttys) {
          execFile('ps', ['-t', tty.replace(/^\/dev\//, ''), '-o', 'pid='], (psErr, psOut) => {
            if (!psErr && psOut.trim().length > 0) anyLive = true
            if (--pending === 0) resolve(!anyLive)
          })
        }
      })
    })
  })
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
