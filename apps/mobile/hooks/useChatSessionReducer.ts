import type { ServerEvent } from '@aji/protocol'
import { ensureMessageExists, type Item } from './chatTypes'

type ReducerDeps = {
  capWindow: (arr: Item[]) => Item[]
  tryApprovalPrompt: (
    msg: Extract<Item, { kind: 'message' }>,
  ) => Extract<Item, { kind: 'prompt' }> | null
}

/**
 * If the message `id` now reads as a Hermes approval, swap it in-place for the
 * prompt card. Runs on both `text_delta` (the approval blocks, so `message_end`
 * may never arrive) and `message_end` (non-blocking / DB replay). All the
 * Hermes-specific matching lives in `deps.tryApprovalPrompt` — this just applies
 * the result.
 */
function maybeConvertApproval(items: Item[], id: string, deps: ReducerDeps): Item[] {
  const msg = items.find((it) => it.kind === 'message' && it.id === id)
  if (msg?.kind !== 'message') return items
  const approval = deps.tryApprovalPrompt(msg)
  return approval ? items.map((it) => (it.id === id ? approval : it)) : items
}

export function reduceItemsForServerEvent(
  prev: Item[],
  event: ServerEvent,
  turnId: string | undefined,
  deps: ReducerDeps,
): Item[] {
  const inWindow = (id: string): boolean => prev.some((it) => it.id === id)

  switch (event.type) {
    case 'message_start': {
      if (!inWindow(event.id)) {
        return deps.capWindow(ensureMessageExists(prev, event.id, turnId, event.role))
      }
      // Item was pre-created by out-of-order text_delta; message_start has authoritative role.
      return prev.map((it) =>
        it.kind === 'message' && it.id === event.id ? { ...it, role: event.role ?? it.role } : it,
      )
    }

    case 'text_delta': {
      let next: Item[]
      if (inWindow(event.id)) {
        next = prev.map((it) =>
          it.kind === 'message' && it.id === event.id ? { ...it, text: it.text + event.text } : it,
        )
      } else {
        // Out-of-order: create placeholder then append text.
        const created = ensureMessageExists(prev, event.id, turnId)
        next = deps.capWindow(
          created.map((it) =>
            it.kind === 'message' && it.id === event.id ? { ...it, text: it.text + event.text } : it,
          ),
        )
      }

      // Fallback for configs where the pre_approval hook isn't firing: a Hermes
      // text approval ("Reply `/approve` to execute …") streams in as a normal
      // assistant message and then BLOCKS waiting for the reply, so `message_end`
      // never arrives. Convert as soon as the pattern is present rather than on
      // completion, else the buttons never show until after the user has replied.
      // When the hook IS active the adapter suppresses this text (see adapter.py
      // _APPROVAL_PROMPT_RE), so the structured permission_request is the only card.
      return maybeConvertApproval(next, event.id, deps)
    }

    case 'message_end': {
      if (inWindow(event.id)) {
        const withDone = prev.map((it) =>
          it.kind === 'message' && it.id === event.id ? { ...it, done: true } : it,
        )
        return maybeConvertApproval(withDone, event.id, deps)
      }
      return deps.capWindow([
        ...prev,
        { kind: 'message', id: event.id, role: 'assistant', text: '', done: true, turnId, createdAt: Date.now() },
      ])
    }

    case 'tool_start':
      if (inWindow(event.id)) return prev
      return deps.capWindow([
        ...prev,
        {
          kind: 'tool',
          id: event.id,
          name: event.name,
          args: event.args,
          done: false,
          turnId,
          createdAt: Date.now(),
        },
      ])

    case 'tool_end':
      if (!inWindow(event.id)) return prev
      return prev.map((it) =>
        it.kind === 'tool' && it.id === event.id ? { ...it, result: event.result, done: true } : it,
      )

    case 'file':
      if (inWindow(event.id)) return prev
      return deps.capWindow([
        ...prev,
        {
          kind: 'file',
          id: event.id,
          role: event.role,
          mime: event.mime,
          data: event.data,
          name: event.name,
          duration: event.duration,
          text: event.text,
          done: true,
          turnId,
          createdAt: Date.now(),
        },
      ])

    case 'permission_request':
      if (inWindow(event.id)) return prev
      return deps.capWindow([
        ...prev,
        {
          kind: 'prompt',
          id: event.id,
          title: event.title,
          message: event.message,
          options: event.options,
          turnId,
          createdAt: Date.now(),
        },
      ])

    case 'clarify':
      if (inWindow(event.id)) return prev
      return deps.capWindow([
        ...prev,
        {
          kind: 'prompt',
          id: event.id,
          title: 'Clarification',
          message: event.question,
          options: event.choices,
          turnId,
          createdAt: Date.now(),
        },
      ])

    case 'prompt_dismiss':
      // Keep already-resolved stubs (this client responded); remove only prompts dismissed elsewhere.
      return prev.flatMap((it) => {
        if (it.kind !== 'prompt' || it.id !== event.id) return [it]
        return it.resolved ? [it] : []
      })

    default:
      return prev
  }
}
