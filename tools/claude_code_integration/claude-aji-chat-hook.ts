/**
 * Claude Code hook → aji-chat bridge.
 *
 * Registered via tools/claude-hooks-install.ts. Called by Claude Code for each
 * lifecycle event (UserPromptSubmit, PreToolUse, PermissionRequest,
 * PostToolUse, Stop). Reads the event payload from stdin, translates it to one
 * or more aji-chat ServerEvents, and POSTs them to the local server. Permission
 * requests block indefinitely until the user responds on mobile. Fails silently
 * if the server isn't running — never wants to break a Claude Code session.
 *
 * Turn ID persistence: UserPromptSubmit mints a turn_id and writes it to a
 * temp file keyed by session_id. Subsequent events within the same session read
 * it so tool calls and the final assistant message are grouped together.
 *
 * Intermediate message capture: Claude's text before and between tool calls
 * lives in the transcript JSONL at `transcript_path`. PreToolUse reads from a
 * per-turn line cursor so each assistant message is emitted exactly once —
 * before the tool that follows it — rather than only the final response at Stop.
 */
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PermissionRequest, PromptOption, ServerEvent } from '@aji/protocol'

const SERVER = process.env.AJI_SERVER ?? 'http://localhost:4000/event'
// Route Claude Desktop's activity to its own server so it doesn't interleave with
// the interactive CLI. Claude Desktop sets CLAUDE_CODE_ENTRYPOINT=claude-desktop;
// the CLI sets "cli". Desktop is view-only on mobile (no channel inbound), so it
// surfaces as a separate, read-only activity feed.
const IS_DESKTOP = process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
const AGENT = IS_DESKTOP ? 'claude-desktop' : 'claude-code'
const DISPLAY_NAME = IS_DESKTOP ? 'Claude Desktop' : 'Claude Code'
const PROMPT_SERVER = process.env.AJI_PROMPT_SERVER ?? 'http://localhost:4000/prompt/wait'
const ACCESS_TOKEN = process.env.AJI_ACCESS_TOKEN?.trim() || undefined

// Set once per invocation so every event in this hook run carries the same
// channel. The auto-launcher exports AJI_CHANNEL when it spawns a session (one
// terminal per mobile-created channel) — that wins so outbound events match the
// channel mobile created and the bridge filters on. Sessions not spawned by the
// launcher (Claude Desktop, a manually-run CLI) have no AJI_CHANNEL and fall back
// to the first 8 chars of session_id — short enough to display, long enough to
// be collision-proof in practice.
let CHANNEL: string | undefined
const CHANNEL_EXEMPT: ReadonlySet<string> = new Set(['server_info', 'commands', 'channels'])

interface PromptResponse {
  type: 'prompt_response'
  id: string
  choice: string
}

interface PermissionSuggestion {
  type?: string
  destination?: string
  behavior?: 'allow' | 'deny' | 'ask'
  directories?: string[]
}

// ---------------------------------------------------------------------------
// Turn state persistence (file-based, keyed by Claude Code session_id)
//
// Stores per-turn metadata between hook invocations:
//  - turnId: groups all events in one turn on mobile
//  - transcriptPath: path to the JSONL transcript (captured when first seen)
//  - lastLine: how many transcript lines have been processed; prevents
//    re-emitting previous messages when reading at each PreToolUse
// ---------------------------------------------------------------------------

interface TurnState {
  turnId: string
  transcriptPath?: string
  lastLine: number
}

function turnStatePath(sessionId: string): string {
  return path.join(os.tmpdir(), `aji-turn-${sessionId}`)
}

function readTurnState(sessionId: string): TurnState | undefined {
  try {
    const raw = fs.readFileSync(turnStatePath(sessionId), 'utf-8').trim()
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as TurnState
    } catch {
      // Legacy format: plain turn ID string (pre-intermediate-message support)
      return { turnId: raw, lastLine: 0 }
    }
  } catch {
    return undefined
  }
}

function writeTurnState(sessionId: string, state: TurnState): void {
  try { fs.writeFileSync(turnStatePath(sessionId), JSON.stringify(state), 'utf-8') } catch { /* ignore */ }
}

function clearTurnState(sessionId: string): void {
  try { fs.unlinkSync(turnStatePath(sessionId)) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Transcript reading helpers
// ---------------------------------------------------------------------------

/**
 * Count lines currently in the transcript. Called at UserPromptSubmit to
 * establish the baseline so we only read messages added during this turn.
 */
function countTranscriptLines(transcriptPath: string): number {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8').trim()
    return content ? content.split('\n').length : 0
  } catch {
    return 0
  }
}

/**
 * Read assistant message texts from the transcript starting at `fromLine`.
 * Returns all texts found and the new line count to use as the next `fromLine`.
 *
 * Only `{"type":"assistant"}` entries are considered; user messages, tool
 * results, and system entries are skipped. An assistant entry may contain both
 * a text block and tool_use blocks (Claude's "think then act" turn) — we only
 * extract the text portion here; tool events come via PreToolUse/PostToolUse.
 */
function readNewAssistantMessages(
  transcriptPath: string,
  fromLine: number,
): { texts: string[]; nextLine: number } {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8').trim()
    const lines = content ? content.split('\n') : []
    const texts: string[] = []
    for (let i = fromLine; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as {
          type?: string
          message?: { content?: Array<{ type: string; text?: string }> }
        }
        if (entry.type === 'assistant' && entry.message?.content) {
          const text = entry.message.content
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text!)
            .join('')
          if (text.trim()) texts.push(text)
        }
      } catch { /* skip malformed line */ }
    }
    return { texts, nextLine: lines.length }
  } catch {
    return { texts: [], nextLine: fromLine }
  }
}

/** Emit a list of assistant texts as complete message_start/text_delta/message_end triples. */
async function emitMessages(texts: string[], turnId: string | undefined): Promise<void> {
  for (const text of texts) {
    const id = randomUUID()
    await emit({ type: 'message_start', id, role: 'assistant', serverId: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
    await emit({ type: 'text_delta', id, text, serverId: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
    await emit({ type: 'message_end', id, serverId: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postJson(url: string, body: unknown, timeoutMs?: number): Promise<unknown | null> {
  const ctrl = new AbortController()
  const timer = timeoutMs != null ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ACCESS_TOKEN) headers['X-Aji-Token'] = ACCESS_TOKEN
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!response.ok) return null
    const text = await response.text()
    return text ? JSON.parse(text) as unknown : null
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// Regular events get a 4 s deadline so a hung server never stalls the hook pipeline.
// Content events carry the session channel; server-level events (server_info,
// commands, channels) are exempt — they're not scoped to a single conversation.
async function emit(event: ServerEvent): Promise<void> {
  await postJson(SERVER, CHANNEL && !CHANNEL_EXEMPT.has(event.type) ? { ...event, channel: CHANNEL } : event, 4000)
}

/**
 * Read the conversation title Claude Desktop auto-generates for this session.
 * Desktop stores a JSON file per session under
 *   ~/Library/Application Support/Claude/claude-code-sessions/<workspace>/<window>/local_<id>.json
 * Each file has a `cliSessionId` that matches the hook's session_id and a
 * `title` string. Returns undefined if not found (non-Desktop, file missing, etc.)
 */
function readDesktopConversationTitle(cliSessionId: string): string | undefined {
  const sessionsDir = path.join(
    os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions',
  )
  try {
    for (const wsId of fs.readdirSync(sessionsDir)) {
      const wsPath = path.join(sessionsDir, wsId)
      if (!fs.statSync(wsPath).isDirectory()) continue
      for (const winId of fs.readdirSync(wsPath)) {
        const winPath = path.join(wsPath, winId)
        if (!fs.statSync(winPath).isDirectory()) continue
        for (const file of fs.readdirSync(winPath)) {
          if (!file.endsWith('.json')) continue
          try {
            const data = JSON.parse(fs.readFileSync(path.join(winPath, file), 'utf-8')) as Record<string, unknown>
            if (data.cliSessionId === cliSessionId && typeof data.title === 'string') {
              return data.title
            }
          } catch { /* skip malformed */ }
        }
      }
    }
  } catch { /* not macOS / not Desktop */ }
  return undefined
}

/** Emit a channels event that names this session's channel with the Desktop conversation title. */
async function emitDesktopChannelName(sessionId: string): Promise<void> {
  if (!IS_DESKTOP || !CHANNEL) return
  const title = readDesktopConversationTitle(sessionId)
  if (!title) return
  await emit({
    type: 'channels',
    serverId: AGENT,
    channels: [{ id: CHANNEL, displayName: title }],
  })
}

async function readStdin(): Promise<Record<string, unknown> | null> {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  if (!data.trim()) return null
  try { return JSON.parse(data) as Record<string, unknown> } catch { return null }
}

function permissionScopeLabel(destination: string | undefined): string {
  switch (destination) {
    case 'userSettings':
      return 'all projects'
    case 'projectSettings':
      return 'this project'
    case 'localSettings':
      return 'this machine'
    case 'session':
      return 'this session'
    default:
      return 'saved rules'
  }
}

// "/Users/bcom/Desktop" → "Desktop/" — the short, human form Claude Code's TUI
// uses when naming a directory scope.
function shortDir(dir: string): string {
  const name = dir.replace(/\/+$/, '').split('/').pop() || dir
  return `${name}/`
}

/**
 * Approximate the single label Claude Code's TUI shows for its combined "Yes,
 * allow …" option. Claude Code applies the whole suggestion set together (e.g.
 * acceptEdits mode + an added directory), so we surface one option, not one per
 * suggestion.
 *
 * NOTE: we cannot reproduce Claude Code's label verbatim — it's generated TUI-side
 * from context not present in the hook payload (the SAME suggestion shape reads as
 * "all edits … this session" for a Write but "access to … this project" for Bash).
 * This mirrors the wording as closely as the structured data allows: file-editing
 * tools phrase as "all edits", everything else as "access", with the directory and
 * the suggestion's own scope.
 */
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'update', 'create'])

function describeSuggestions(suggestions: PermissionSuggestion[], toolName: string): string {
  let denyRules = false
  const dirs: string[] = []
  let destination: string | undefined
  for (const s of suggestions) {
    if (s.destination) destination = s.destination
    if (s.type === 'addDirectories' && Array.isArray(s.directories)) dirs.push(...s.directories)
    else if (s.type === 'addRules' && s.behavior === 'deny') denyRules = true
  }
  const scope = permissionScopeLabel(destination)
  const where = dirs.length ? ` ${dirs.map(shortDir).join(', ')}` : ''
  if (denyRules) return `Always deny${where} (${scope})`
  if (EDIT_TOOLS.has(toolName.toLowerCase())) {
    return `Allow all edits${where ? ` in${where}` : ''} (${scope})`
  }
  return `Always allow${where ? ` access to${where}` : ''} (${scope})`
}

function buildPermissionOptions(payload: Record<string, unknown>): {
  options: PromptOption[]
  suggestions: PermissionSuggestion[]
} {
  const suggestions = Array.isArray(payload.permission_suggestions)
    ? payload.permission_suggestions as PermissionSuggestion[]
    : []

  // Claude Code applies the whole suggestion set as one "allow" action, so we
  // mirror its three-option layout: allow once / allow + apply suggestions / deny.
  const toolName = String(payload.tool_name ?? '')
  const options: PromptOption[] = [{ id: 'allow_once', label: 'Allow once' }]
  if (suggestions.length > 0) {
    options.push({ id: 'apply_suggestions', label: describeSuggestions(suggestions, toolName) })
  }
  options.push({ id: 'deny', label: 'Deny' })

  return { options, suggestions }
}

function permissionMessage(payload: Record<string, unknown>): string {
  const toolName = String(payload.tool_name ?? 'Unknown tool')
  const toolInput = JSON.stringify((payload.tool_input as Record<string, unknown>) ?? {}, null, 2)
  return `${toolName} is requesting permission.\n\n${toolInput}`
}

async function waitForPermission(prompt: PermissionRequest): Promise<PromptResponse | null> {
  const result = await postJson(PROMPT_SERVER, { prompt }) as { response: PromptResponse | null } | null
  return result?.response ?? null
}

function writeHookJson(body: unknown): void {
  process.stdout.write(`${JSON.stringify(body)}\n`)
}

// ---------------------------------------------------------------------------
// Model-level commands exposed to the mobile command picker.
//
// NOTE: These are NOT Claude Code CLI slash commands (/compact, /clear, etc.).
// CLI commands run at the terminal layer before the model sees anything — they
// cannot be triggered through the channel bridge. Instead, we emit model-level
// prompts that Claude the model can actually act on when received via channel.
// ---------------------------------------------------------------------------

async function emitClaudeCodeServerInfo(): Promise<void> {
  // Advertise as multi-channel so the mobile home screen shows the channel list
  // (one channel per session). Desktop is view-only (no inbound channel bridge),
  // so we skip emitting commands for it. Idempotent; server caches + replays to
  // late connectors.
  await emit({
    type: 'server_info',
    serverId: AGENT,
    monoChannel: false,
    displayName: DISPLAY_NAME,
  })
}

async function emitClaudeCodeCommands(): Promise<void> {
  await emit({
    type: 'commands',
    serverId: AGENT,
    commands: [
      // Status / awareness
      { name: 'status',    description: 'What are you currently working on?',               category: 'Info' },
      { name: 'summarize', description: 'Summarize what you have done so far this session', category: 'Info' },
      { name: 'memory',    description: 'Show me what is in your CLAUDE.md memory files',  category: 'Info' },

      // Session
      { name: 'compact',   description: 'Summarize and compress our conversation to save context', category: 'Session', args_hint: '[focus]' },

      // Review
      { name: 'plan',      description: 'Explain your plan before you start',              category: 'Review' },
      { name: 'diff',      description: 'Show me a summary of all changes made so far',    category: 'Review' },
    ],
  })
}

async function main(): Promise<void> {
  const payload = await readStdin()
  if (!payload) return

  const event = payload.hook_event_name as string | undefined
  const sessionId = String(payload.session_id ?? 'default')
  CHANNEL = process.env.AJI_CHANNEL?.trim() || sessionId.slice(0, 8)

  switch (event) {
    case 'UserPromptSubmit': {
      const prompt = String(payload.prompt ?? '')

      // If this prompt originated from the phone (via the channel bridge), the
      // user already sees it on mobile — don't echo it back wrapped in <channel> tags.
      const fromAjiChat = /<channel\s+source="aji-chat"[^>]*>/.test(prompt)

      const id = randomUUID()
      const turnId = randomUUID()
      const transcriptPath = payload.transcript_path as string | undefined
      // Record how many transcript lines exist before this turn so PreToolUse
      // only reads messages added during the current turn (not session history).
      const lastLine = transcriptPath ? countTranscriptLines(transcriptPath) : 0
      writeTurnState(sessionId, { turnId, transcriptPath, lastLine })

      if (!fromAjiChat) {
        await emit({ type: 'message_start', id, role: 'user', serverId: AGENT, turn_id: turnId })
        await emit({ type: 'text_delta', id, text: prompt, serverId: AGENT, turn_id: turnId })
        await emit({ type: 'message_end', id, serverId: AGENT, turn_id: turnId })
      }
      await emit({ type: 'status', value: 'thinking', serverId: AGENT })
      // Advertise mono-channel + populate the mobile command picker on first
      // contact so both are available immediately (server caches them for the
      // session lifetime).
      await emitClaudeCodeServerInfo()
      if (!IS_DESKTOP) await emitClaudeCodeCommands()
      await emitDesktopChannelName(sessionId)
      break
    }
    case 'PreToolUse': {
      // tool_use_id is stable across PreToolUse / PostToolUse for the same call
      const id = String(payload.tool_use_id ?? randomUUID())
      const state = readTurnState(sessionId)
      const turnId = state?.turnId
      // transcript_path may arrive here even if it wasn't in UserPromptSubmit
      const transcriptPath = (payload.transcript_path as string | undefined) ?? state?.transcriptPath

      // Flush any assistant text Claude wrote before this tool call. The
      // transcript already contains the full assistant turn (text + tool_use
      // blocks) by the time PreToolUse fires, so we read it here rather than
      // waiting for Stop — which would otherwise drop all intermediate messages.
      if (transcriptPath && state) {
        const { texts, nextLine } = readNewAssistantMessages(transcriptPath, state.lastLine)
        await emitMessages(texts, turnId)
        writeTurnState(sessionId, { ...state, transcriptPath, lastLine: nextLine })
      }

      await emit({ type: 'status', value: 'working', serverId: AGENT })
      await emit({
        type: 'tool_start',
        id,
        name: String(payload.tool_name ?? 'unknown'),
        args: (payload.tool_input as Record<string, unknown>) ?? {},
        serverId: AGENT,
        ...(turnId ? { turn_id: turnId } : {}),
      })
      break
    }
    case 'PermissionRequest': {
      // Desktop has no inbound channel — the user can't respond from mobile, so
      // fall through to Claude's default behavior.
      if (IS_DESKTOP) break
      const { options, suggestions } = buildPermissionOptions(payload)
      const state = readTurnState(sessionId)
      const response = await waitForPermission({
        type: 'permission_request',
        id: randomUUID(),
        title: `${String(payload.tool_name ?? 'Tool')} permission`,
        message: permissionMessage(payload),
        options,
        serverId: AGENT,
      })

      if (!response) break

      if (response.choice === 'allow_once') {
        writeHookJson({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
          },
        })
        break
      }

      if (response.choice === 'deny') {
        writeHookJson({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'deny',
              message: 'Permission denied from aji-chat',
            },
          },
        })
        break
      }

      if (response.choice === 'apply_suggestions') {
        const { suggestions: s } = buildPermissionOptions(payload)
        if (s.length === 0) break
        writeHookJson({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'allow',
              updatedPermissions: s,
            },
          },
        })
      }

      void state // used above for turn context; no further action needed
      break
    }
    case 'PostToolUse': {
      const id = String(payload.tool_use_id ?? randomUUID())
      const state = readTurnState(sessionId)
      const turnId = state?.turnId
      await emit({ type: 'tool_end', id, result: payload.tool_response, serverId: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
      // Claude resumes reasoning after the tool result — go back to thinking so
      // mobile doesn't show the agent as still running a tool between calls.
      await emit({ type: 'status', value: 'thinking', serverId: AGENT })
      break
    }
    case 'Stop': {
      const state = readTurnState(sessionId)
      clearTurnState(sessionId)
      const transcriptPath = (payload.transcript_path as string | undefined) ?? state?.transcriptPath
      const turnId = state?.turnId

      // Emit idle first so mobile is unblocked even if subsequent emits time out.
      await emit({ type: 'status', value: 'idle', serverId: AGENT })

      // Emit any assistant messages not yet flushed by PreToolUse — this covers
      // the final response (no tool follows it) and any messages missed if
      // transcript_path wasn't available during earlier PreToolUse calls.
      if (transcriptPath) {
        const { texts } = readNewAssistantMessages(transcriptPath, state?.lastLine ?? 0)
        await emitMessages(texts, turnId)
      }

      // Refresh mono-channel advertisement + the mobile command picker when
      // Claude goes idle — best time to send (and re-seed the server cache if it
      // restarted mid-session). Emit the channel name at Stop too — the title is
      // more likely to be finalized by the time the turn ends.
      await emitClaudeCodeServerInfo()
      if (!IS_DESKTOP) await emitClaudeCodeCommands()
      await emitDesktopChannelName(sessionId)
      break
    }
    default:
      // Unknown event type — ignore silently
      break
  }
}

main().catch(() => { /* never throw — Claude Code should never see an error */ })
