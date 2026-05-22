/**
 * Claude Code hook → aji-chat bridge.
 *
 * Registered via tools/claude-hooks-install.ts. Called by Claude Code for each
 * lifecycle event (UserPromptSubmit, PreToolUse, PostToolUse, Stop). Reads the
 * event payload from stdin, translates it to one or more aji-chat ServerEvents,
 * and POSTs them to the local server. Fails silently if the server isn't
 * running — never wants to break a Claude Code session.
 */
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ServerEvent } from '@aji/protocol'

const SERVER = process.env.AJI_SERVER ?? 'http://localhost:4000/event'

async function emit(event: ServerEvent): Promise<void> {
  try {
    await fetch(SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
  } catch {
    // server not running — silently swallow; never break the Claude Code session
  }
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

async function main(): Promise<void> {
  const payload = await readStdin()
  if (!payload) return

  const event = payload.hook_event_name as string | undefined

  switch (event) {
    case 'UserPromptSubmit': {
      const id = randomUUID()
      await emit({ type: 'message_start', id, role: 'user' })
      await emit({ type: 'text_delta', id, text: String(payload.prompt ?? '') })
      await emit({ type: 'message_end', id })
      await emit({ type: 'status', value: 'thinking' })
      break
    }
    case 'PreToolUse': {
      // tool_use_id is stable across PreToolUse / PostToolUse for the same call
      const id = String(payload.tool_use_id ?? randomUUID())
      await emit({ type: 'status', value: 'working' })
      await emit({
        type: 'tool_start',
        id,
        name: String(payload.tool_name ?? 'unknown'),
        args: (payload.tool_input as Record<string, unknown>) ?? {},
      })
      break
    }
    case 'PostToolUse': {
      const id = String(payload.tool_use_id ?? randomUUID())
      await emit({ type: 'tool_end', id, result: payload.tool_response })
      break
    }
    case 'Stop': {
      const path = payload.transcript_path as string | undefined
      const text = path ? lastAssistantText(path) : null
      if (text) {
        const id = randomUUID()
        await emit({ type: 'message_start', id, role: 'assistant' })
        await emit({ type: 'text_delta', id, text })
        await emit({ type: 'message_end', id })
      }
      await emit({ type: 'status', value: 'idle' })
      break
    }
    default:
      // Unknown event type — ignore silently
      break
  }
}

main().catch(() => { /* never throw — Claude Code should never see an error */ })
