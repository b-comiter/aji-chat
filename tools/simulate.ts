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

  // Add a second simulation with code blocks for testing syntax highlighting
  await sleep(1000)
  await emit({ type: 'status', value: 'thinking' })
  await sleep(400)

  const msg3 = newId('msg')
  await emit({ type: 'message_start', id: msg3, role: 'assistant' })
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
  await emit({ type: 'message_end', id: msg3 })
  await sleep(500)
  await emit({ type: 'status', value: 'idle' })
  console.log('simulation complete')
}

await run()
