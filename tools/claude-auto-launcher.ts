/**
 * aji-chat → Claude Code AUTO-LAUNCHER (spawn-on-demand, one terminal per channel).
 *
 * Complements the inbound channel bridge (tools/claude-channel-bridge.ts). The
 * bridge can only inject a phone message into a Claude Code session that is
 * ALREADY running. This launcher closes that gap: when a message arrives from
 * the phone for a channel whose session is not alive, it opens a visible
 * Terminal.app window running Claude Code with the message as the opening prompt.
 * Everything after that flows through the channel bridge as usual.
 *
 * Multi-session model: each aji-chat CHANNEL in the claude-code server maps 1:1
 * to its own terminal — tmux session `aji-cc-<channel>`, spawned in that
 * channel's working directory (from the registry's `ChannelInfo.cwd`). The
 * launcher exports `AJI_CHANNEL=<channel>` before invoking `claude`, so the hook
 * and bridge (both subprocesses of that claude) inherit it and act per-channel.
 *
 * It is a plain WEBHOOK SUBSCRIBER, not an MCP server — the same adapter pattern
 * the bridge uses. It requires NO server changes (the aji-chat server stays a
 * dumb router): it self-registers a webhook against the running server and
 * reacts to the ClientEvents the server forwards. It also POSTs `sessions`
 * ServerEvents back to /event so mobile can mark channels whose terminal is gone
 * as archived.
 *
 * Events handled:
 *   • user_message  → spawn the channel's session if not alive (else the bridge delivers)
 *   • delete_channel → kill the channel's tmux session (the phone deleted it)
 *   • get_sessions   → reply with which channels currently have a live session
 *
 * Requires tmux (`brew install tmux`): it lets us programmatically dismiss
 * Claude Code's interactive dev-channels warning while keeping the session
 * visible/attachable on the Mac, and gives each channel an addressable session.
 *
 * Interplay with the bridge (no double-delivery): each running session's bridge
 * filters by both serverId AND channel, so a message for channel A reaches only
 * A's session. When A's session is already alive, this launcher detects it
 * (tmux has-session) and does nothing; when it isn't, the launcher spawns it.
 *
 * Env:
 *   AJI_SERVER       base URL of the aji-chat server   (default http://localhost:4000)
 *   AJI_AGENT        which server this represents       (default claude-code)
 *   AJI_PROJECT_DIR  fallback cwd for spawned sessions  (default process.cwd())
 *   AJI_CLAUDE_BIN   claude executable                  (default "claude", resolved on PATH)
 *   AJI_TMUX_PREFIX  tmux session-name prefix           (default "aji-cc")
 *   AJI_LAUNCH_DRYRUN=1  log the spawn instead of opening Terminal (used by the smoke test)
 */
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { execFile } from 'node:child_process'
import type { ChannelInfo, ChannelId, ClientEvent, ServerEvent, UserMessage } from '@aji/protocol'
import { startWebhookClient, type WebhookClient } from './lib/webhookClient.ts'

const AJI_SERVER = (process.env.AJI_SERVER ?? 'http://localhost:4000').replace(/\/$/, '')
const AJI_AGENT = process.env.AJI_AGENT ?? 'claude-code'
const ACCESS_TOKEN = process.env.AJI_ACCESS_TOKEN?.trim()
const PROJECT_DIR = process.env.AJI_PROJECT_DIR ?? process.cwd()
const CLAUDE_BIN = process.env.AJI_CLAUDE_BIN ?? 'claude'
const TMUX_BIN = process.env.AJI_TMUX_BIN ?? 'tmux'
const TMUX_PREFIX = process.env.AJI_TMUX_PREFIX ?? 'aji-cc'
const DRY_RUN = process.env.AJI_LAUNCH_DRYRUN === '1'

// The launch flag that loads our custom channel.
const CHANNEL_FLAG = '--dangerously-load-development-channels server:aji-chat'

const DEFAULT_CHANNEL = 'general'

function log(...args: unknown[]): void {
  console.error('[aji-launcher]', ...args)
}

/**
 * tmux session name for a channel. tmux session names may not contain `.` or `:`
 * (they delimit target specs), so we map them to `_`; channel ids are otherwise
 * already normalized to `[a-z0-9._-]` on mobile. The mapping is forward-only —
 * liveness is always derived from the registry (channel → session), never by
 * reversing a session name back to a channel.
 */
export function tmuxSessionFor(channel: string): string {
  const safe = (channel || DEFAULT_CHANNEL).replace(/[.:]/g, '_')
  return `${TMUX_PREFIX}-${safe}`
}

/**
 * tmux `-t` target that forces an EXACT name match. A bare name is matched by
 * tmux as exact → prefix → fnmatch, so with short channel ids (`t`, `t2`, `t4`)
 * a command could resolve to the wrong session. The leading `=` disables the
 * fuzzy fallbacks, so every command hits exactly its own session.
 */
function tmuxTarget(session: string): string {
  return `=${session}`
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
 * Exports `AJI_CHANNEL` so the spawned claude — and the hook / bridge it spawns —
 * stamp and filter events for this channel. The initial prompt is passed via
 * `"$(cat <file>)"` rather than inlined: command substitution inside double
 * quotes is not re-parsed by the shell, so arbitrary message text (quotes,
 * spaces, newlines) survives intact without bespoke escaping.
 *
 * The `--` before the prompt is REQUIRED: `--dangerously-load-development-channels`
 * is variadic and would otherwise swallow the prompt as an (untagged) channel
 * entry — `claude` then exits with "entries must be tagged". `--` ends option
 * parsing so the prompt lands as the positional `[prompt]`, and also protects a
 * message that happens to start with `-`.
 */
export function buildLaunchCommand(opts: {
  cwd: string
  claudeBin: string
  promptFile: string
  channel: string
}): string {
  // `|| exec zsh -l`: if any step fails (bad cwd, claude missing/crashes) keep
  // the pane open in a shell so the user sees the error scrollback — otherwise the
  // window closes instantly and the attaching Terminal reports "can't find session".
  return (
    `export AJI_CHANNEL=${JSON.stringify(opts.channel)} && ` +
    `cd ${JSON.stringify(opts.cwd)} && ` +
    `${opts.claudeBin} ${CHANNEL_FLAG} -- "$(cat ${JSON.stringify(opts.promptFile)})" || exec zsh -l`
  )
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

// ---------------------------------------------------------------------------
// Server I/O — read the channel registry, post sessions events back.
// ---------------------------------------------------------------------------

async function fetchChannels(): Promise<ChannelInfo[]> {
  try {
    const headers: Record<string, string> = {}
    if (ACCESS_TOKEN) headers['X-Aji-Token'] = ACCESS_TOKEN
    const res = await fetch(`${AJI_SERVER}/channels?serverId=${encodeURIComponent(AJI_AGENT)}`, { headers })
    if (!res.ok) return []
    const body = (await res.json()) as { channels?: ChannelInfo[] }
    return Array.isArray(body.channels) ? body.channels : []
  } catch {
    return []
  }
}

/**
 * Expand a leading `~` to the home dir. The cwd arrives from mobile as a plain
 * string and is passed to the shell *quoted* (so message text needs no escaping),
 * which means the shell never expands a tilde — we must do it here or `cd "~/x"`
 * fails and the session dies on launch.
 */
function expandHome(dir: string): string {
  if (dir === '~') return os.homedir()
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2))
  return dir
}

/**
 * Working directory for a channel: its registered cwd (tilde-expanded), else the
 * default. Falls back to PROJECT_DIR when the registered dir doesn't exist, so a
 * typo'd path can't silently kill the session — a bad `cd` aborts the launch
 * chain before claude runs, and tmux ends the window.
 */
async function resolveCwd(channel: string): Promise<string> {
  const channels = await fetchChannels()
  const raw = channels.find((c) => c.id === channel)?.cwd?.trim()
  if (!raw) return PROJECT_DIR
  const dir = expandHome(raw)
  try {
    if (fs.statSync(dir).isDirectory()) return dir
    log(`channel ${channel} cwd is not a directory (${dir}) — using ${PROJECT_DIR}`)
  } catch {
    log(`channel ${channel} cwd not found (${raw}) — using ${PROJECT_DIR}`)
  }
  return PROJECT_DIR
}

async function emit(event: ServerEvent): Promise<void> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ACCESS_TOKEN) headers['X-Aji-Token'] = ACCESS_TOKEN
    await fetch(`${AJI_SERVER}/event`, { method: 'POST', headers, body: JSON.stringify(event) })
  } catch {
    /* best effort — never break on a server outage */
  }
}

/** Report which registered channels currently have a live tmux session. */
async function emitSessions(): Promise<void> {
  const channels = await fetchChannels()
  const live: ChannelId[] = []
  for (const c of channels) {
    if (await sessionRunning(c.id)) live.push(c.id)
  }
  log('reporting live sessions:', live.join(', ') || '(none)')
  await emit({ type: 'sessions', serverId: AJI_AGENT, liveChannels: live })
}

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

/** True when a Claude Code session for this channel is already running. */
function sessionRunning(channel: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(TMUX_BIN, ['has-session', '-t', tmuxTarget(tmuxSessionFor(channel))], (err) => resolve(!err))
  })
}

// Suppress duplicate spawns while a freshly-launched session boots and becomes
// visible to tmux. Keyed by channel; cleared after the boot window elapses.
const spawning = new Set<string>()
const SPAWN_LOCK_MS = 30_000

function launchSession(channel: string, text: string): void {
  spawning.add(channel)
  setTimeout(() => spawning.delete(channel), SPAWN_LOCK_MS)

  const session = tmuxSessionFor(channel)
  const stamp = Date.now()
  const promptFile = path.join(os.tmpdir(), `aji-cc-initial-${stamp}.txt`)
  const scriptFile = path.join(os.tmpdir(), `aji-cc-launch-${stamp}.sh`)

  void resolveCwd(channel).then((cwd) => {
    const shellCommand = buildLaunchCommand({ cwd, claudeBin: CLAUDE_BIN, promptFile, channel })
    try {
      fs.writeFileSync(promptFile, text, 'utf8')
      // The claude command runs from a script file so its quoting/`$(cat …)`
      // survive intact through tmux + osascript instead of being escaped thrice.
      fs.writeFileSync(scriptFile, `#!/bin/zsh -l\n${shellCommand}\n`, 'utf8')
    } catch (err) {
      log('failed to stage launch files:', (err as Error).message)
      spawning.delete(channel)
      return
    }

    if (DRY_RUN) {
      log(`DRYRUN would launch session ${session} in ${cwd} →`, text.slice(0, 80))
      return
    }

    // Clear any stale same-named session (only reached when no live session
    // exists), then start the claude command detached inside tmux.
    execFile(TMUX_BIN, ['kill-session', '-t', tmuxTarget(session)], () => {
      execFile(
        TMUX_BIN,
        ['new-session', '-d', '-s', session, '-x', '220', '-y', '50', `zsh -l ${scriptFile}`],
        (err) => {
          if (err) {
            log('tmux new-session failed:', err.message)
            spawning.delete(channel)
            return
          }
          log(`tmux session ${session} started in ${cwd}; initial prompt:`, text.slice(0, 80))
          // NOTE: deliberately NO `client-detached → kill-session` hook. In the
          // multi-session model each channel is a durable terminal you can close
          // the window on and return to; the session persists until the channel is
          // explicitly deleted. (The old hook tied session lifetime to its window,
          // which — with several windows/Terminal tabs sharing one tmux server —
          // let an incidental detach take a session down.) Closing a window now
          // just leaves the session detached; re-messaging reopens a window.
          autoAcceptDevChannelWarning(session)
          openVisibleTerminal(session)
          // Let other clients know this channel now has a live session.
          void emitSessions()
        },
      )
    })
  })
}

// The --dangerously-load-development-channels flag shows an interactive warning
// ("I am using this for local development") that blocks startup. Poll the pane
// for it and press Enter (option 1 is preselected) so the session boots
// unattended. Gives up after ~15s if it never appears.
function autoAcceptDevChannelWarning(session: string): void {
  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    execFile(TMUX_BIN, ['capture-pane', '-p', '-t', tmuxTarget(session)], (err, stdout) => {
      if (err) { clearInterval(timer); return } // session gone
      if (stdout.includes('Loading development channels')) {
        clearInterval(timer)
        execFile(TMUX_BIN, ['send-keys', '-t', tmuxTarget(session), 'Enter'], () => {})
        log('auto-accepted dev-channels warning for', session)
      } else if (attempts >= 30) {
        clearInterval(timer)
      }
    })
  }, 500)
}

// Open a visible Terminal.app window attached to the tmux session so the user can
// watch and take over the running Claude Code session on their Mac. `attach -d`
// detaches any other (including stale/phantom) client of THIS session so the new
// window takes over; the `=` target keeps it scoped to exactly this session.
//
// Unlike every other tmux call here (which use execFile → no shell), this one runs
// through Terminal's `do script` → zsh. The `=` target MUST be single-quoted: zsh
// EQUALS expansion treats a bare `=word` as "path of command word" and aborts with
// "word not found". (Session names are sanitized to [a-z0-9_-], so no quote risk.)
function openVisibleTerminal(session: string): void {
  const script = buildTerminalAppleScript(`${TMUX_BIN} attach -d -t '${tmuxTarget(session)}'`)
  execFile('osascript', ['-e', script], (err) => {
    if (err) log('osascript attach failed:', err.message)
  })
}

/**
 * Kill a channel's session (the phone deleted the channel) and re-report. The
 * `=` exact target guarantees we only ever destroy this one session, never a
 * prefix-sibling (`t` vs `t2`/`t4`).
 */
function killSession(channel: string): void {
  const session = tmuxSessionFor(channel)
  if (DRY_RUN) {
    log(`DRYRUN would kill session ${session}`)
    void emitSessions()
    return
  }
  execFile(TMUX_BIN, ['kill-session', '-t', tmuxTarget(session)], (err) => {
    if (err) log(`kill-session ${session}:`, err.message)
    else log(`killed session ${session}`)
    void emitSessions()
  })
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

async function handleEvent(event: ClientEvent): Promise<void> {
  // Phone deleted the channel → tear down its terminal.
  if (event.type === 'delete_channel' && event.serverId === AJI_AGENT) {
    killSession(event.channel)
    return
  }

  // Phone asked which sessions are alive → answer.
  if (event.type === 'get_sessions' && event.serverId === AJI_AGENT) {
    await emitSessions()
    return
  }

  if (!shouldLaunch(event, AJI_AGENT)) return
  const channel = event.channel ?? DEFAULT_CHANNEL

  if (spawning.has(channel)) {
    log(`spawn already in progress for ${channel} — skipping`)
    return
  }
  if (await sessionRunning(channel)) {
    // The session is alive (claude + its bridge are still running), so the bridge
    // delivers this message regardless. If the window was closed, just REOPEN one
    // attached to the existing session — don't relaunch, which would kill claude
    // and lose its context. This keeps each channel a durable terminal.
    if (await tmuxSessionNeedsWindow(tmuxSessionFor(channel))) {
      log(`session for ${channel} is alive but its window is closed — reopening`)
      openVisibleTerminal(tmuxSessionFor(channel))
    } else {
      log(`session for ${channel} already running — channel bridge will deliver`)
    }
    return
  }
  log(`no live session for ${channel} — launching for:`, event.text.slice(0, 80))
  launchSession(channel, event.text)
}

// True when a tmux session exists but has no *live* attached terminal: either no
// clients at all, or only stale/phantom clients whose tty has no live process (a
// Terminal window that closed without tmux noticing).
function tmuxSessionNeedsWindow(session: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(TMUX_BIN, ['has-session', '-t', tmuxTarget(session)], (hasErr) => {
      if (hasErr) return resolve(false) // not our tmux session (or none) → caller spawns
      execFile(TMUX_BIN, ['list-clients', '-t', tmuxTarget(session), '-F', '#{client_tty}'], (lcErr, stdout) => {
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
      void handleEvent(JSON.parse(body) as ClientEvent)
    } catch {
      /* ignore malformed payloads */
    }
  })
})

// ---------------------------------------------------------------------------
// Webhook (de)registration against the running aji-chat server.
// ---------------------------------------------------------------------------
let webhook: WebhookClient | null = null

function shutdown(): void {
  void (webhook?.stop() ?? Promise.resolve()).finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

async function main(): Promise<void> {
  httpServer.listen(0, '127.0.0.1', () => {
    const addr = httpServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    log('webhook listener on port', port)
    webhook = startWebhookClient({ serverBase: AJI_SERVER, serverId: AJI_AGENT, accessToken: ACCESS_TOKEN, port, log })
  })
  log('auto-launcher started; agent =', AJI_AGENT, 'server =', AJI_SERVER, 'projectDir =', PROJECT_DIR)
}

// Only run the listener when executed directly (so tests can import the pure
// helpers without spawning anything).
if (process.env.AJI_LAUNCHER_TEST !== '1') {
  main().catch((err) => log('fatal:', (err as Error).message))
}
