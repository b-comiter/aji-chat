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
 */
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PermissionRequest, PromptOption, ServerEvent } from '@aji/protocol'

const SERVER = process.env.AJI_SERVER ?? 'http://localhost:4000/event'
const AGENT = 'claude-code'
const PROMPT_SERVER = process.env.AJI_PROMPT_SERVER ?? 'http://localhost:4000/prompt/wait'
const ACCESS_TOKEN = process.env.AJI_ACCESS_TOKEN?.trim() || undefined

interface PromptResponse {
  type: 'prompt_response'
  id: string
  choice: string
}

interface PermissionSuggestion {
  type?: string
  mode?: string
  destination?: string
  behavior?: 'allow' | 'deny' | 'ask'
  rules?: Array<{ toolName?: string; ruleContent?: string }>
}

// ---------------------------------------------------------------------------
// Turn ID persistence (file-based, keyed by Claude Code session_id)
// ---------------------------------------------------------------------------

function turnStatePath(sessionId: string): string {
  return path.join(os.tmpdir(), `aji-turn-${sessionId}`)
}

function readTurnId(sessionId: string): string | undefined {
  try {
    return fs.readFileSync(turnStatePath(sessionId), 'utf-8').trim() || undefined
  } catch {
    return undefined
  }
}

function writeTurnId(sessionId: string, turnId: string): void {
  try { fs.writeFileSync(turnStatePath(sessionId), turnId, 'utf-8') } catch { /* ignore */ }
}

function clearTurnId(sessionId: string): void {
  try { fs.unlinkSync(turnStatePath(sessionId)) } catch { /* ignore */ }
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
async function emit(event: ServerEvent): Promise<void> {
  await postJson(SERVER, event, 4000)
}

async function readStdin(): Promise<Record<string, unknown> | null> {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  if (!data.trim()) return null
  try { return JSON.parse(data) as Record<string, unknown> } catch { return null }
}

/**
 * Read a Claude Code transcript (JSONL) and return the text of the most recent
 * assistant turn. Returns null if the file is missing/empty/no assistant text.
 */
function lastAssistantText(transcriptPath: string): string | null {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
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
          if (text) return text
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* file missing */ }
  return null
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
 * Summarize ALL permission suggestions into the single label Claude Code's TUI
 * shows for its combined "Yes, allow …" option. Claude Code applies the whole
 * suggestion set together (e.g. acceptEdits mode + an added directory), so we
 * surface one option, not one per suggestion.
 */
function describeSuggestions(suggestions: PermissionSuggestion[]): string {
  let acceptEdits = false
  let allowRules = false
  let denyRules = false
  const dirs: string[] = []
  let destination: string | undefined
  for (const s of suggestions) {
    if (s.destination) destination = s.destination
    if (s.type === 'setMode' && s.mode === 'acceptEdits') acceptEdits = true
    else if (s.type === 'addDirectories' && Array.isArray(s.directories)) dirs.push(...s.directories)
    else if (s.type === 'addRules') {
      if (s.behavior === 'deny') denyRules = true
      else allowRules = true
    }
  }
  const scope = permissionScopeLabel(destination)
  const where = dirs.length ? ` in ${dirs.map(shortDir).join(', ')}` : ''
  if (acceptEdits) return `Allow all edits${where} (${scope})`
  if (denyRules) return `Always deny (${scope})`
  if (allowRules || dirs.length) return `Always allow${where} (${scope})`
  return `Apply suggested permissions (${scope})`
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
  const options: PromptOption[] = [{ id: 'allow_once', label: 'Allow once' }]
  if (suggestions.length > 0) {
    options.push({ id: 'apply_suggestions', label: describeSuggestions(suggestions) })
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
  // Advertise Claude Code as a single-channel server so the mobile home screen
  // opens its one chat directly instead of drilling into a (one-entry) channel
  // list. Idempotent on the mobile side; the server also caches + replays it to
  // clients that connect later.
  await emit({
    type: 'server_info',
    serverId: AGENT,
    monoChannel: true,
    displayName: 'Claude Code',
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

  switch (event) {
    case 'UserPromptSubmit': {
      const prompt = String(payload.prompt ?? '')

      // If this prompt originated from the phone (via the channel bridge), the
      // user already sees it on mobile — don't echo it back wrapped in <channel> tags.
      const fromAjiChat = /<channel\s+source="aji-chat"[^>]*>/.test(prompt)

      const id = randomUUID()
      const turnId = randomUUID()
      writeTurnId(sessionId, turnId)

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
      await emitClaudeCodeCommands()
      break
    }
    case 'PreToolUse': {
      // tool_use_id is stable across PreToolUse / PostToolUse for the same call
      const id = String(payload.tool_use_id ?? randomUUID())
      const turnId = readTurnId(sessionId)
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
      const { options, suggestions } = buildPermissionOptions(payload)
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
        if (suggestions.length === 0) break
        writeHookJson({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'allow',
              updatedPermissions: suggestions,
            },
          },
        })
      }
      break
    }
    case 'PostToolUse': {
      const id = String(payload.tool_use_id ?? randomUUID())
      const turnId = readTurnId(sessionId)
      await emit({ type: 'tool_end', id, result: payload.tool_response, serverId: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
      break
    }
    case 'Stop': {
      const transcriptPath = payload.transcript_path as string | undefined
      const text = transcriptPath ? lastAssistantText(transcriptPath) : null
      const turnId = readTurnId(sessionId)
      if (text) {
        const id = randomUUID()
        await emit({ type: 'message_start', id, role: 'assistant', serverId: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
        await emit({ type: 'text_delta', id, text, serverId: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
        await emit({ type: 'message_end', id, serverId: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
      }
      clearTurnId(sessionId)
      await emit({ type: 'status', value: 'idle', serverId: AGENT })
      // Refresh mono-channel advertisement + the mobile command picker when
      // Claude goes idle — best time to send (and re-seed the server cache if it
      // restarted mid-session).
      await emitClaudeCodeServerInfo()
      await emitClaudeCodeCommands()
      break
    }
    default:
      // Unknown event type — ignore silently
      break
  }
}

main().catch(() => { /* never throw — Claude Code should never see an error */ })
