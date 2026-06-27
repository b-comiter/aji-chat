import type { PermissionRequest, PromptResponse, ServerEvent } from '@aji/protocol'

type BroadcastFn = (event: ServerEvent) => void

type PromptWaiter = {
  resolve: (event: PromptResponse | null) => void
  timeout: ReturnType<typeof setTimeout>
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
    clearTimeout(waiter.timeout)
    dismissPrompt(event.id)
    waiter.resolve(event)
    return true
  }

  function waitForPrompt(prompt: PermissionRequest): Promise<PromptResponse | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (waiters.delete(prompt.id)) {
          dismissPrompt(prompt.id)
          resolve(null)
        }
      }, timeoutMs)

      // Register before broadcasting so an immediate prompt_response cannot race
      // ahead of this waiter and get dropped.
      waiters.set(prompt.id, { resolve, timeout })
      broadcast(prompt)

      // Safety valve: prevent stale waiters from blocking the prompt slot.
    })
  }

  function cancelPrompt(id: string): boolean {
    const waiter = waiters.get(id)
    if (!waiter) {
      dismissPrompt(id)
      return false
    }
    waiters.delete(id)
    clearTimeout(waiter.timeout)
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
