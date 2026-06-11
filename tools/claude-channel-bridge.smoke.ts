/**
 * Isolated smoke test for the channel bridge.
 *
 * Spawns tools/claude-channel-bridge.ts, discovers its ephemeral webhook port from
 * stderr, then POSTs ClientEvents directly to that listener (simulating what the
 * aji-chat server's webhook dispatch would do). Asserts the routing predicate:
 *   - user_message for our agent       → forwarded
 *   - user_message with no agent       → forwarded (back-compat)
 *   - user_message for a DIFFERENT agent → NOT forwarded
 *   - non-message ClientEvent          → NOT forwarded
 *
 * Does NOT require the aji-chat server or a real Claude Code session. The actual
 * channel injection is verified manually end-to-end (see docs).
 *
 * Run: pnpm channel:smoke
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'

const TSX = path.resolve('node_modules/.bin/tsx')

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => T | null, timeoutMs: number): Promise<T | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v !== null) return v
    await delay(50)
  }
  return null
}

async function post(url: string, body: unknown): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => { /* listener always 200s; ignore */ })
}

async function main(): Promise<void> {
  const proc = spawn(TSX, ['tools/claude-channel-bridge.ts'], {
    // Point at a definitely-dead server so webhook registration fails fast and
    // quietly — we are testing the listener + routing in isolation.
    env: { ...process.env, AJI_AGENT: 'claude-code', AJI_SERVER: 'http://localhost:59999' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stderr = ''
  proc.stderr.on('data', (d) => { stderr += d.toString() })
  proc.stdout.on('data', () => { /* MCP JSON-RPC stream — ignore */ })

  const port = await waitFor(() => {
    const m = stderr.match(/webhook listener on port (\d+)/)
    return m ? Number(m[1]) : null
  }, 8000)

  if (!port) {
    proc.kill('SIGKILL')
    console.error('SMOKE FAILED: bridge never reported a listener port.\n--- stderr ---\n' + stderr)
    process.exit(1)
  }

  const base = `http://localhost:${port}/`

  await post(base, { type: 'user_message', text: 'hello from mobile', serverId: 'claude-code' })
  await post(base, { type: 'user_message', text: 'no serverId field' })
  await post(base, { type: 'user_message', text: 'for hermes', serverId: 'hermes' })
  await post(base, { type: 'get_commands' })

  await delay(400)
  proc.kill('SIGINT')

  const forwarded = [...stderr.matchAll(/forwarding user_message → (.+)/g)].map((m) => m[1].trim())

  const ok =
    forwarded.length === 2 &&
    forwarded.includes('hello from mobile') &&
    forwarded.includes('no serverId field') &&
    !forwarded.some((t) => t.includes('for hermes'))

  if (!ok) {
    console.error('SMOKE FAILED. forwarded =', JSON.stringify(forwarded))
    console.error('--- stderr ---\n' + stderr)
    process.exit(1)
  }

  console.log('✓ SMOKE PASSED — forwarded exactly:', JSON.stringify(forwarded))
  process.exit(0)
}

main().catch((err) => {
  console.error('SMOKE ERROR:', err)
  process.exit(1)
})
