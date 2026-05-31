/**
 * Replay a realistic agent run over the WebSocket protocol so the mobile
 * client can be developed against representative data before any real agent
 * is wired up.
 *
 * Usage: pnpm simulate
 */
import { readFileSync } from 'node:fs'
import type { ServerEvent } from '@aji/protocol'
import { newId } from '@aji/protocol'

const SERVER = 'http://localhost:4000/event'
const AGENT = 'simulate'

// A tiny committed MP3 tone, read once and base64-encoded so we can replay an
// audio (`file`) event end-to-end. MP3 decodes on both iOS and Android.
const SAMPLE_MP3_B64 = readFileSync(
  new URL('./assets/sample.mp3', import.meta.url),
).toString('base64')

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
    await emit({ type: 'text_delta', id, text: chunk, agent: AGENT })
    await sleep(delayMs)
  }
}

async function run(): Promise<void> {
  console.log('starting simulated agent run…')

  await emit({ type: 'status', value: 'thinking', agent: AGENT })
  await sleep(600)

  const msg1 = newId('msg')
  await emit({ type: 'message_start', id: msg1, role: 'assistant', agent: AGENT })
  await streamText(msg1, 'Let me check what files are in your project.')
  await emit({ type: 'message_end', id: msg1, agent: AGENT })
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
    agent: AGENT,
  })
  await sleep(600)

  await emit({ type: 'status', value: 'working', agent: AGENT })
  const tool1 = newId('tool')
  await emit({
    type: 'tool_start',
    id: tool1,
    name: 'list_files',
    args: { path: '.' },
    agent: AGENT,
  })
  await sleep(900)
  await emit({
    type: 'tool_end',
    id: tool1,
    result: ['README.md', 'package.json', 'src/index.ts'],
    agent: AGENT,
  })
  await sleep(400)

  const msg2 = newId('msg')
  await emit({ type: 'message_start', id: msg2, role: 'assistant', agent: AGENT })
  await streamText(
    msg2,
    "I found three files. I'd like to read src/index.ts — that requires permission.",
  )
  await emit({ type: 'message_end', id: msg2, agent: AGENT })
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
    agent: AGENT,
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
    agent: AGENT,
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
    agent: AGENT,
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
    agent: AGENT,
  })

  await sleep(2000)
  await emit({ type: 'status', value: 'idle', agent: AGENT })

  // Second run: code blocks for testing syntax highlighting
  await sleep(1000)
  await emit({ type: 'status', value: 'thinking', agent: AGENT })
  await sleep(400)

  const msg3 = newId('msg')
  await emit({ type: 'message_start', id: msg3, role: 'assistant', agent: AGENT })
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
  await emit({ type: 'message_end', id: msg3, agent: AGENT })
  await sleep(500)
  await emit({ type: 'status', value: 'idle', agent: AGENT })
  console.log('simulation complete')
}

await run()
