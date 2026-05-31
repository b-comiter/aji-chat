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
