import { reduceItemsForServerEvent } from './useChatSessionReducer'
import { tryApprovalPrompt } from './hermesApproval'
import type { Item } from './chatTypes'

const deps = {
  capWindow: (arr: Item[]) => arr,
  tryApprovalPrompt,
}

const APPROVAL_TEXT =
  '⚠️ **Dangerous command requires approval:**\n```\npython3 -c "import os"\n```\n' +
  'Reason: script execution via -e/-c flag\n\n' +
  'Reply `/approve` to execute, `/approve session` to approve this pattern for the session, ' +
  '`/approve always` to approve permanently, or `/deny` to cancel.'

describe('reduceItemsForServerEvent — Hermes text approval', () => {
  test('converts a streamed approval message to a prompt on text_delta (no message_end needed)', () => {
    // The agent blocks after sending the approval text, so message_end never
    // arrives — the card must materialize from text_delta alone.
    let items: Item[] = []
    items = reduceItemsForServerEvent(
      items,
      { type: 'message_start', id: 'msg-1', role: 'assistant' },
      'turn-1',
      deps,
    )
    items = reduceItemsForServerEvent(
      items,
      { type: 'text_delta', id: 'msg-1', text: APPROVAL_TEXT },
      'turn-1',
      deps,
    )

    const item = items.find((it) => it.id === 'msg-1')
    expect(item?.kind).toBe('prompt')
    if (item?.kind !== 'prompt') throw new Error('expected prompt')
    expect(item.options.map((o) => o.id)).toEqual([
      '/approve',
      '/approve session',
      '/approve always',
      '/deny',
    ])
    // Command is packed into the message body so PromptRow renders a code block.
    expect(item.message).toContain('python3 -c')
  })

  test('leaves an ordinary assistant message as a message', () => {
    let items: Item[] = []
    items = reduceItemsForServerEvent(
      items,
      { type: 'message_start', id: 'msg-2', role: 'assistant' },
      undefined,
      deps,
    )
    items = reduceItemsForServerEvent(
      items,
      { type: 'text_delta', id: 'msg-2', text: 'just a normal reply' },
      undefined,
      deps,
    )
    expect(items.find((it) => it.id === 'msg-2')?.kind).toBe('message')
  })

  test('a later text_delta for the converted prompt does not throw or revert it', () => {
    let items: Item[] = []
    items = reduceItemsForServerEvent(
      items,
      { type: 'text_delta', id: 'msg-3', text: APPROVAL_TEXT },
      'turn-1',
      deps,
    )
    expect(items.find((it) => it.id === 'msg-3')?.kind).toBe('prompt')
    // Trailing delta arrives after conversion — must stay a prompt, no crash.
    items = reduceItemsForServerEvent(
      items,
      { type: 'text_delta', id: 'msg-3', text: ' (extra)' },
      'turn-1',
      deps,
    )
    expect(items.find((it) => it.id === 'msg-3')?.kind).toBe('prompt')
  })
})
