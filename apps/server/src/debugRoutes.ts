import type { Hono } from 'hono'

type LogFn = (direction: ' ', tag: string, detail?: unknown) => void

export function registerDebugRoutes(app: Hono, log: LogFn): void {
  /**
   * Receive a DB dump from the mobile client and print it to the server console.
   * Triggered by the /view-db slash command in the chat screen.
   */
  app.post('/db/dump', async (c) => {
    const { agents, itemCounts } = await c.req.json<{
      agents: Array<{
        id: string
        display_name: string
        last_status: string
        last_message_preview: string | null
        last_event_at: number | null
      }>
      itemCounts: Record<string, { messages: number; tools: number; prompts: number }>
    }>()

    log(' ', 'POST /db/dump')

    if (agents.length === 0) {
      console.log('\n[DB DUMP] No agents in database.\n')
      return c.json({ logged: true })
    }

    const rows = agents.map((a) => {
      const counts = itemCounts[a.id] ?? { messages: 0, tools: 0, prompts: 0 }
      return {
        id:       a.id,
        name:     a.display_name,
        status:   a.last_status,
        messages: counts.messages,
        tools:    counts.tools,
        prompts:  counts.prompts,
        preview:  (a.last_message_preview ?? '').slice(0, 40) || '—',
      }
    })

    console.log('\n[DB DUMP]')
    console.table(rows)
    console.log('')

    return c.json({ logged: true })
  })

  /**
   * Receive a chat history dump from the mobile client and print it to the
   * server console. Triggered by the /view-chat-history slash command.
   */
  app.post('/chat/dump', async (c) => {
    const { chatId, items } = await c.req.json<{
      chatId: string
      items: Array<{
        kind: 'message' | 'tool'
        role?: string
        text?: string
        name?: string
        args?: Record<string, unknown>
        result?: unknown
        done: boolean
      }>
    }>()

    log(' ', `POST /chat/dump  chat=${chatId} items=${items.length}`)

    if (items.length === 0) {
      console.log(`\n[CHAT DUMP] No items for chat "${chatId}".\n`)
      return c.json({ logged: true })
    }

    const rows = items.map((it, i) => {
      if (it.kind === 'tool') {
        const argsStr = JSON.stringify(it.args ?? {})
        const preview = `${it.name}(${argsStr})`.slice(0, 100)
        return { '#': i + 1, role: '(tool)', content: preview, done: it.done ? '✓' : '…' }
      }
      return {
        '#': i + 1,
        role: it.role ?? '—',
        content: (it.text ?? '').replace(/\n/g, ' ').slice(0, 100) || '—',
        done: it.done ? '✓' : '…',
      }
    })

    console.log(`\n[CHAT DUMP] chat=${chatId}`)
    console.table(rows)
    console.log('')

    return c.json({ logged: true })
  })

  /**
   * Receive the last N messages from the mobile client and print them to the
   * server console. Triggered by the /view-last-n-msgs slash command.
   */
  app.post('/last-messages/dump', async (c) => {
    const { chatId, messages } = await c.req.json<{
      chatId: string
      messages: Array<{
        id: string
        role: 'assistant' | 'user' | 'system'
        text: string
        done: boolean
      }>
    }>()

    log(' ', `POST /last-messages/dump  chat=${chatId} messages=${messages.length}`)

    if (messages.length === 0) {
      console.log(`\n[LAST MESSAGES] No messages for chat "${chatId}".\n`)
      return c.json({ logged: true })
    }

    console.log(`\n[LAST MESSAGES] chat=${chatId} (${messages.length} message${messages.length !== 1 ? 's' : ''})`)

    const rows = messages.map((msg, i) => ({
      '#': i + 1,
      role: msg.role,
      text: msg.text.replace(/\n/g, ' ').slice(0, 1000) || '—',
      done: msg.done ? '✓' : '…',
    }))
    console.table(rows)

    return c.json({ logged: true })
  })
}
