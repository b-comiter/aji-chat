/**
 * Replay a realistic agent run over the WebSocket protocol so the mobile
 * client can be developed against representative data before any real agent
 * is wired up.
 *
 * Usage: pnpm simulate
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
import type { ServerEvent } from '@aji/protocol'
import { newId } from '@aji/protocol'

const SERVER = 'http://localhost:4000/event'
const AGENT = 'simulate'
const ACCESS_TOKEN = process.env.AJI_ACCESS_TOKEN?.trim()

// A tiny committed MP3 tone, read once and base64-encoded so we can replay an
// audio (`file`) event end-to-end. MP3 decodes on both iOS and Android.
const SAMPLE_MP3_B64 = readFileSync(
  new URL('./assets/sample.mp3', import.meta.url),
).toString('base64')

// ── Synthetic file payloads (image / markdown / html) ────────────────────────
// Generated in-process so we can exercise the non-audio `file` render paths
// (inline image thumbnail + full-screen document viewer) without committing
// binary fixtures.

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/**
 * Encode a diagonal-gradient RGB PNG — a valid, obviously-a-bitmap image (so a
 * tester can tell it actually decoded, vs. a solid-color UI placeholder).
 */
function gradientPng(size: number): string {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit depth, RGB color type
  const raw = Buffer.alloc(size * (1 + size * 3))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      raw[o++] = Math.round((x / (size - 1)) * 255)         // R ramps left→right
      raw[o++] = Math.round((y / (size - 1)) * 255)         // G ramps top→bottom
      raw[o++] = Math.round((1 - x / (size - 1)) * 255)     // B ramps right→left
    }
  }
  const idat = zlib.deflateSync(raw)
  const png = Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return png.toString('base64')
}

const SAMPLE_PNG_B64 = gradientPng(128)

const SAMPLE_MD_B64 = Buffer.from(
  [
    '# Project status',
    '',
    'A **markdown** document delivered as a `file` event.',
    '',
    '- Inline base64 over the wire',
    '- Rendered full-screen on tap',
    '',
    '```ts',
    "const greet = (name: string) => `Hello, ${name}!`",
    '```',
    '',
    '> Replays from SQLite after an app restart.',
    '',
  ].join('\n'),
  'utf8',
).toString('base64')

const SAMPLE_HTML_B64 = Buffer.from(
  [
    '<!doctype html><html><head>',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>body{font-family:-apple-system,system-ui,sans-serif;padding:24px;color:#222}',
    'h1{color:#5e8eff}code{background:#f0f0f0;padding:2px 4px;border-radius:4px}</style>',
    '</head><body>',
    '<h1>HTML document</h1>',
    '<p>Rendered in an in-app <code>WebView</code> from inline base64.</p>',
    '<ul><li>One</li><li>Two</li><li>Three</li></ul>',
    '</body></html>',
  ].join(''),
  'utf8',
).toString('base64')

async function emit(event: ServerEvent): Promise<void> {
  await fetch(SERVER, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ACCESS_TOKEN ? { 'X-Aji-Token': ACCESS_TOKEN } : {}),
    },
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
    await emit({ type: 'text_delta', id, text: chunk, serverId: AGENT })
    await sleep(delayMs)
  }
}

async function run(): Promise<void> {
  console.log('starting simulated agent run…')

  await emit({ type: 'status', value: 'thinking', serverId: AGENT })
  await sleep(600)

  const msg1 = newId('msg')
  await emit({ type: 'message_start', id: msg1, role: 'assistant', serverId: AGENT })
  await streamText(msg1, 'Let me check what files are in your project.')
  await emit({ type: 'message_end', id: msg1, serverId: AGENT })
  await sleep(300)

  // Audio (file) message — exercises the inline-base64 `file` event.
  console.log('emitting audio message with base64 data…')
  await emit({
    type: 'file',
    id: newId('file'),
    role: 'assistant',
    mime: 'audio/mpeg',
    name: 'sample.mp3',
    duration: 1,
    data: SAMPLE_MP3_B64,
    text: 'Here is a voice clip.',
    serverId: AGENT,
  })
  await sleep(600)

  // Image (file) message — exercises the inline thumbnail + full-screen viewer.
  console.log('emitting image, markdown, and html file events…')
  await emit({
    type: 'file',
    id: newId('file'),
    role: 'assistant',
    mime: 'image/png',
    name: 'gradient.png',
    data: SAMPLE_PNG_B64,
    text: 'A generated gradient.',
    serverId: AGENT,
  })
  await sleep(500)

  // Markdown (file) message — file chip → full-screen rendered markdown.
  await emit({
    type: 'file',
    id: newId('file'),
    role: 'assistant',
    mime: 'text/markdown',
    name: 'status.md',
    data: SAMPLE_MD_B64,
    serverId: AGENT,
  })
  await sleep(500)

  // HTML (file) message — file chip → full-screen WebView.
  await emit({
    type: 'file',
    id: newId('file'),
    role: 'assistant',
    mime: 'text/html',
    name: 'report.html',
    data: SAMPLE_HTML_B64,
    serverId: AGENT,
  })
  await sleep(600)

  await emit({ type: 'status', value: 'working', serverId: AGENT })
  const tool1 = newId('tool')
  await emit({
    type: 'tool_start',
    id: tool1,
    name: 'list_files',
    args: { path: '.' },
    serverId: AGENT,
  })
  await sleep(900)
  await emit({
    type: 'tool_end',
    id: tool1,
    result: ['README.md', 'package.json', 'src/index.ts'],
    serverId: AGENT,
  })
  await sleep(400)

  const msg2 = newId('msg')
  await emit({ type: 'message_start', id: msg2, role: 'assistant', serverId: AGENT })
  await streamText(
    msg2,
    "I found three files. I'd like to read src/index.ts — that requires permission.",
  )
  await emit({ type: 'message_end', id: msg2, serverId: AGENT })
  await sleep(300)

  // 1. Bash command — subtitle + code block
  await emit({
    type: 'permission_request',
    id: newId('perm'),
    title: 'Bash permission',
    message: [
      'Bash is requesting permission.',
      '',
      JSON.stringify({
        command: 'mkdir -p /Users/bcom/.claude/projects/-Users-bcom-dev-aji-chat/memory',
        description: 'Ensure memory directory exists',
        timeout: 10000,
      }, null, 2),
    ].join('\n'),
    options: [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'suggestion:0', label: 'Always allow (this project)' },
      { id: 'deny', label: 'Deny' },
    ],
    serverId: AGENT,
  })
  await sleep(1200)

  // 2. Write — file path as subtitle
  await emit({
    type: 'permission_request',
    id: newId('perm'),
    title: 'Write permission',
    message: [
      'Write is requesting permission.',
      '',
      JSON.stringify({
        file_path: '/Users/bcom/.claude/projects/-Users-bcom-dev-aji-chat/memory/MEMORY.md',
        content: '# Memory index\n- [Overview](project_overview.md) — what we\'re building\n',
      }, null, 2),
    ].join('\n'),
    options: [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ],
    serverId: AGENT,
  })
  await sleep(1200)

  // 3. AskUserQuestion — question list with labeled options
  await emit({
    type: 'permission_request',
    id: newId('perm'),
    title: 'AskUserQuestion permission',
    message: [
      'AskUserQuestion is requesting permission.',
      '',
      JSON.stringify({
        questions: [
          {
            question: 'How should mobile messages be routed to the right agent?',
            header: 'Routing',
            options: [
              {
                label: 'Add `agent` to UserMessage',
                description: 'Small protocol change: mobile stamps the chatId on each user_message; the bridge filters to claude-code only.',
              },
              {
                label: 'Forward all messages',
                description: 'No protocol change. The bridge injects every user_message into Claude Code. Simplest, but messages from other chats would leak in.',
              },
            ],
            multiSelect: false,
          },
          {
            question: 'Want a fallback for idle session delivery?',
            header: 'Idle delivery',
            options: [
              {
                label: 'Channel push only',
                description: 'Simplest. Rely on the channel feature; verify idle-wake behavior during testing.',
              },
              {
                label: 'Add file-inbox fallback',
                description: 'Belt-and-suspenders: bridge writes messages to a file, CLAUDE.md tells Claude to check it each turn.',
              },
            ],
            multiSelect: false,
          },
        ],
      }, null, 2),
    ].join('\n'),
    options: [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ],
    serverId: AGENT,
  })
  await sleep(1200)

  // 4. ExitPlanMode — plan preview in rationale
  await emit({
    type: 'permission_request',
    id: newId('perm'),
    title: 'ExitPlanMode permission',
    message: [
      'ExitPlanMode is requesting permission.',
      '',
      JSON.stringify({
        plan: '# Plan: Switch MessageList to inverted FlatList\n\n## Context\nWe\'ve burned a long session on scroll/restore inside a non-inverted FlatList. The fundamental problem: "bottom" is a moving target when adding messages extends the content.\n\n## Approach\nAdd `inverted` prop and reverse data at the FlatList boundary only. Upstream code stays chronological.',
      }, null, 2),
    ].join('\n'),
    options: [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ],
    serverId: AGENT,
  })

  await sleep(2000)
  await emit({ type: 'status', value: 'idle', serverId: AGENT })

  // Second run: code blocks for testing syntax highlighting
  await sleep(1000)
  await emit({ type: 'status', value: 'thinking', serverId: AGENT })
  await sleep(400)

  const msg3 = newId('msg')
  await emit({ type: 'message_start', id: msg3, role: 'assistant', serverId: AGENT })
  await streamText(
    msg3,
    `Here you go:

**Python:**
\`\`\`python
def greet(name: str) -> str:
    return f"Hello, {name}!"

print(greet("World"))
\`\`\`

**Rust:**
\`\`\`rust
fn main() {
    let nums = vec![1, 2, 3, 4, 5];
    let sum: i32 = nums.iter().sum();
    println!("Sum: {}", sum);
}
\`\`\`

**JavaScript:**
\`\`\`javascript
const double = (n) => n * 2;
console.log(double(21));
\`\`\`

**Bash:**
\`\`\`bash
echo "Disk usage:"
df -h / | tail -1
\`\`\`

**SQL:**
\`\`\`sql
SELECT name, COUNT(*) cnt
FROM users
JOIN orders ON users.id = orders.user_id
GROUP BY name
ORDER BY cnt DESC
LIMIT 10;
\`\`\`

**Go:**
\`\`\`go
package main

import "fmt"

func main() {
    ch := make(chan string, 1)
    ch <- "ping"
    fmt.Println(<-ch)
}
\`\`\`

Let me know if you'd like more!`,
  )
  await emit({ type: 'message_end', id: msg3, serverId: AGENT })
  await sleep(500)
  await emit({ type: 'status', value: 'idle', serverId: AGENT })
  console.log('simulation complete')
}

await run()
