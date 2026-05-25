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

interface PromptResponse {
  type: 'prompt_response'
  id: string
  choice: string
}

interface PermissionSuggestion {
  type?: string
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

async function postJson(url: string, body: unknown): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) return null
    const text = await response.text()
    return text ? JSON.parse(text) as unknown : null
  } catch {
    return null
  }
}

async function emit(event: ServerEvent): Promise<void> {
  await postJson(SERVER, event)
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

function permissionSuggestionLabel(suggestion: PermissionSuggestion, index: number): string {
  if (suggestion.type === 'addRules' && suggestion.behavior === 'allow') {
    return `Always allow (${permissionScopeLabel(suggestion.destination)})`
  }
  return `Apply suggestion ${index + 1}`
}

function buildPermissionOptions(payload: Record<string, unknown>): {
  options: PromptOption[]
  suggestions: PermissionSuggestion[]
} {
  const suggestions = Array.isArray(payload.permission_suggestions)
    ? payload.permission_suggestions as PermissionSuggestion[]
    : []

  const options: PromptOption[] = [{ id: 'allow_once', label: 'Allow once' }]
  suggestions.forEach((suggestion, index) => {
    options.push({ id: `suggestion:${index}`, label: permissionSuggestionLabel(suggestion, index) })
  })
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

async function main(): Promise<void> {
  const payload = await readStdin()
  if (!payload) return

  const event = payload.hook_event_name as string | undefined
  const sessionId = String(payload.session_id ?? 'default')

  switch (event) {
    case 'UserPromptSubmit': {
      const id = randomUUID()
      const turnId = randomUUID()
      writeTurnId(sessionId, turnId)
      await emit({ type: 'message_start', id, role: 'user', agent: AGENT, turn_id: turnId })
      await emit({ type: 'text_delta', id, text: String(payload.prompt ?? ''), agent: AGENT, turn_id: turnId })
      await emit({ type: 'message_end', id, agent: AGENT, turn_id: turnId })
      await emit({ type: 'status', value: 'thinking', agent: AGENT })
      break
    }
    case 'PreToolUse': {
      // tool_use_id is stable across PreToolUse / PostToolUse for the same call
      const id = String(payload.tool_use_id ?? randomUUID())
      const turnId = readTurnId(sessionId)
      await emit({ type: 'status', value: 'working', agent: AGENT })
      await emit({
        type: 'tool_start',
        id,
        name: String(payload.tool_name ?? 'unknown'),
        args: (payload.tool_input as Record<string, unknown>) ?? {},
        agent: AGENT,
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
        agent: AGENT,
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

      if (response.choice.startsWith('suggestion:')) {
        const index = Number(response.choice.slice('suggestion:'.length))
        const suggestion = suggestions[index]
        if (!suggestion) break
        writeHookJson({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'allow',
              updatedPermissions: [suggestion],
            },
          },
        })
      }
      break
    }
    case 'PostToolUse': {
      const id = String(payload.tool_use_id ?? randomUUID())
      const turnId = readTurnId(sessionId)
      await emit({ type: 'tool_end', id, result: payload.tool_response, agent: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
      break
    }
    case 'Stop': {
      const transcriptPath = payload.transcript_path as string | undefined
      const text = transcriptPath ? lastAssistantText(transcriptPath) : null
      const turnId = readTurnId(sessionId)
      if (text) {
        const id = randomUUID()
        await emit({ type: 'message_start', id, role: 'assistant', agent: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
        await emit({ type: 'text_delta', id, text, agent: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
        await emit({ type: 'message_end', id, agent: AGENT, ...(turnId ? { turn_id: turnId } : {}) })
      }
      clearTurnId(sessionId)
      await emit({ type: 'status', value: 'idle', agent: AGENT })
      break
    }
    default:
      // Unknown event type — ignore silently
      break
  }
}

main().catch(() => { /* never throw — Claude Code should never see an error */ })
