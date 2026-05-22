/**
 * Replay a realistic agent run over the WebSocket protocol so the mobile
 * client can be developed against representative data before any real agent
 * is wired up.
 *
 * Usage: pnpm simulate
 */
import type { ServerEvent } from '@aji/protocol'
import { newId } from '@aji/protocol'

const SERVER = 'http://localhost:4000/event'

async function emit(event: ServerEvent): Promise<void> {
  await fetch(SERVER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Break a string into 3–5-character chunks to mimic token streaming. */
function chunks(text: string, size = 4): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

async function streamText(id: string, text: string, delayMs = 35): Promise<void> {
  for (const chunk of chunks(text)) {
    await emit({ type: 'text_delta', id, text: chunk })
    await sleep(delayMs)
  }
}

async function run(): Promise<void> {
  console.log('starting simulated agent run…')

  await emit({ type: 'status', value: 'thinking' })
  await sleep(600)

  const msg1 = newId('msg')
  await emit({ type: 'message_start', id: msg1, role: 'assistant' })
  await streamText(msg1, 'Let me check what files are in your project.')
  await emit({ type: 'message_end', id: msg1 })
  await sleep(300)

  await emit({ type: 'status', value: 'working' })
  const tool1 = newId('tool')
  await emit({
    type: 'tool_start',
    id: tool1,
    name: 'list_files',
    args: { path: '.' },
  })
  await sleep(900)
  await emit({
    type: 'tool_end',
    id: tool1,
    result: ['README.md', 'package.json', 'src/index.ts'],
  })
  await sleep(400)

  const msg2 = newId('msg')
  await emit({ type: 'message_start', id: msg2, role: 'assistant' })
  await streamText(
    msg2,
    "I found three files. I'd like to read src/index.ts — that requires permission.",
  )
  await emit({ type: 'message_end', id: msg2 })
  await sleep(300)

  await emit({
    type: 'permission_request',
    id: newId('perm'),
    title: 'Read file',
    message: 'Allow reading src/index.ts?',
    options: [
      { id: 'once', label: 'Allow once' },
      { id: 'always', label: 'Always allow' },
      { id: 'cancel', label: 'Cancel' },
    ],
  })

  await sleep(2000)
  await emit({ type: 'status', value: 'idle' })
  console.log('simulation complete')
}

await run()
