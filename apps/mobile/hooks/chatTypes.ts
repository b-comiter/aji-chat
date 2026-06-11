import type { PromptOption } from '@aji/protocol'
import type { ItemRow } from '../db/database'

export type Item =
  | { kind: 'message'; id: string; role: 'assistant' | 'user' | 'system'; text: string; done: boolean; turnId?: string }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; result?: unknown; done: boolean; turnId?: string }
  | { kind: 'prompt'; id: string; title: string; message: string; options: PromptOption[]; turnId?: string; resolved?: boolean; resolvedChoice?: string; choiceLabel?: string }
  | { kind: 'file'; id: string; role: 'assistant' | 'user' | 'system'; mime: string; data: string; name?: string; duration?: number; text?: string; done: boolean; turnId?: string }

export function rowToItem(row: ItemRow): Item {
  return JSON.parse(row.data) as Item
}

// Common streaming-cursor glyphs + simple ANSI show/hide sequences an agent may
// leave on the tail of in-flight assistant text.
const STREAM_CURSOR_RE = /\s*(?:▉|▍|█|▌|\||_|\x1b\[\?25[lh])\s*$/

/** Strip a trailing streaming-cursor glyph from assistant text (no-op if absent). */
export function stripStreamingCursor(text: string): string {
  return text.replace(STREAM_CURSOR_RE, '')
}

/**
 * Text the "Copy" action puts on the clipboard for an item, or '' when there's
 * nothing copyable. Assistant text has its streaming cursor stripped; files copy
 * their caption (if any); non-text items (tools, prompts) return ''.
 */
export function messageCopyText(item: Item): string {
  if (item.kind === 'message') {
    return item.role === 'user' ? item.text : stripStreamingCursor(item.text)
  }
  if (item.kind === 'file') return item.text ?? ''
  return ''
}

/**
 * Ensure a message exists in the items array. Creates a placeholder if missing.
 * Used only for out-of-order guards on message_start and text_delta — NOT for
 * message_end (which must update an existing item, not just create one).
 */
export function ensureMessageExists(
  items: Item[],
  messageId: string,
  turnId: string | undefined,
  role: 'assistant' | 'user' | 'system' = 'assistant',
): Item[] {
  if (items.some((it) => it.kind === 'message' && it.id === messageId)) return items
  return [...items, { kind: 'message', id: messageId, role, text: '', done: false, turnId }]
}
