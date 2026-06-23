/**
 * Shared webhook-subscriber registration for tools that consume ClientEvents the
 * aji-chat server forwards (the inbound channel bridge and the auto-launcher).
 *
 * Both run a tiny local HTTP listener, register its URL with the server scoped to
 * a serverId, re-register periodically (the server's webhook set is in-memory, so
 * a restart wipes it), and deregister on shutdown. This module owns that lifecycle
 * so the two callers don't duplicate it.
 */

export interface WebhookClientOptions {
  /** Base URL of the aji-chat server, e.g. http://localhost:4000 (no trailing slash). */
  serverBase: string
  /** serverId this subscriber represents — the server only forwards matching events. */
  serverId: string
  /** Optional shared secret sent as X-Aji-Token. */
  accessToken?: string
  /** Port of the local HTTP listener to register. */
  port: number
  /** Logger (stderr-only for the stdio bridge). */
  log: (...args: unknown[]) => void
  /** Re-registration interval; defaults to 30s. */
  intervalMs?: number
}

export interface WebhookClient {
  /** Clear the timer and deregister (best effort). Await before exit. */
  stop: () => Promise<void>
}

/**
 * Register the webhook immediately, then re-register on an interval. Returns a
 * handle whose `stop()` clears the timer and deregisters.
 */
export function startWebhookClient(opts: WebhookClientOptions): WebhookClient {
  const url = `http://localhost:${opts.port}/`
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.accessToken ? { 'X-Aji-Token': opts.accessToken } : {}),
  }

  async function register(): Promise<void> {
    try {
      await fetch(`${opts.serverBase}/webhook`, {
        method: 'POST',
        headers,
        // Scope to serverId so the server only forwards events targeting it.
        body: JSON.stringify({ url, serverId: opts.serverId }),
      })
      opts.log('registered webhook', url, 'with', opts.serverBase)
    } catch (err) {
      opts.log('webhook registration failed (server down? will retry):', (err as Error).message)
    }
  }

  async function deregister(): Promise<void> {
    try {
      await fetch(`${opts.serverBase}/webhook`, { method: 'DELETE', headers, body: JSON.stringify({ url }) })
      opts.log('deregistered webhook', url)
    } catch {
      /* best effort on shutdown */
    }
  }

  void register()
  const timer = setInterval(() => void register(), opts.intervalMs ?? 30_000)

  return {
    async stop() {
      clearInterval(timer)
      await deregister()
    },
  }
}
