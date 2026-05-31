import type { ServerEvent } from '@aji/protocol'
import { ensureMessageExists, type Item } from './chatTypes'

type ReducerDeps = {
  capWindow: (arr: Item[]) => Item[]
  tryApprovalPrompt: (
    msg: Extract<Item, { kind: 'message' }>,
  ) => Extract<Item, { kind: 'prompt' }> | null
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
      if (inWindow(event.id)) {
        return prev.map((it) =>
          it.kind === 'message' && it.id === event.id ? { ...it, text: it.text + event.text } : it,
        )
      }
      // Out-of-order: create placeholder then append text.
      const created = ensureMessageExists(prev, event.id, turnId)
      return deps.capWindow(
        created.map((it) =>
          it.kind === 'message' && it.id === event.id ? { ...it, text: it.text + event.text } : it,
        ),
      )
    }

    case 'message_end': {
      if (inWindow(event.id)) {
        const withDone = prev.map((it) =>
          it.kind === 'message' && it.id === event.id ? { ...it, done: true } : it,
        )
        const justDone = withDone.find((it) => it.kind === 'message' && it.id === event.id)
        if (justDone?.kind === 'message') {
          const approval = deps.tryApprovalPrompt(justDone)
          if (approval) return withDone.map((it) => (it.id === event.id ? approval : it))
        }
        return withDone
      }
      return deps.capWindow([
        ...prev,
        { kind: 'message', id: event.id, role: 'assistant', text: '', done: true, turnId },
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
