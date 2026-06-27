import type { PermissionRequest, PromptResponse, ServerEvent } from '@aji/protocol'

type BroadcastFn = (event: ServerEvent) => void

type PromptWaiter = {
  resolve: (event: PromptResponse | null) => void
}

type PromptWaiters = {
  resolvePrompt: (event: PromptResponse) => boolean
  waitForPrompt: (prompt: PermissionRequest) => Promise<PromptResponse | null>
  cancelPrompt: (id: string) => boolean
}

type Options = {
  broadcast: BroadcastFn
  timeoutMs?: number
}

export function createPromptWaiters({ broadcast, timeoutMs = 10 * 60 * 1000 }: Options): PromptWaiters {
  const waiters = new Map<string, PromptWaiter>()

  function dismissPrompt(id: string): void {
    broadcast({ type: 'prompt_dismiss', id })
  }

  function resolvePrompt(event: PromptResponse): boolean {
    const waiter = waiters.get(event.id)
    if (!waiter) return false
    waiters.delete(event.id)
    dismissPrompt(event.id)
    waiter.resolve(event)
    return true
  }

  function waitForPrompt(prompt: PermissionRequest): Promise<PromptResponse | null> {
    broadcast(prompt)
    return new Promise((resolve) => {
      waiters.set(prompt.id, { resolve })
      // Safety valve: prevent stale waiters from blocking the prompt slot.
      setTimeout(() => {
        if (waiters.delete(prompt.id)) {
          dismissPrompt(prompt.id)
          resolve(null)
        }
      }, timeoutMs)
    })
  }

  function cancelPrompt(id: string): boolean {
    const waiter = waiters.get(id)
    if (!waiter) {
      dismissPrompt(id)
      return false
    }
    waiters.delete(id)
    waiter.resolve(null)
    dismissPrompt(id)
    return true
  }

  return {
    resolvePrompt,
    waitForPrompt,
    cancelPrompt,
  }
}
