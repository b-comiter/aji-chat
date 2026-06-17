import type { ServerEvent } from '@aji/protocol'
import { notificationFor, messagePreview } from './push'

describe('messagePreview', () => {
  it('collapses whitespace and trims', () => {
    expect(messagePreview('  hello   world\n\nthere ')).toBe('hello world there')
  })

  it('falls back to "New message" for empty/whitespace text', () => {
    expect(messagePreview('')).toBe('New message')
    expect(messagePreview('   \n ')).toBe('New message')
  })

  it('truncates long text with an ellipsis', () => {
    const out = messagePreview('x'.repeat(500))
    expect(out.length).toBe(180)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('notificationFor — push content + deep-link data', () => {
  it('builds a message_end note titled "server:channel" with the preview as the body', () => {
    const event: ServerEvent = { type: 'message_end', id: 'm1', serverId: 'hermes', channel: 'daily' }
    expect(notificationFor(event, { displayName: 'Hermes', text: 'the answer is 42' })).toEqual({
      title: 'Hermes:daily',
      body: 'the answer is 42',
      data: { serverId: 'hermes', channel: 'daily' },
    })
  })

  it('drops the default "general" channel from the title', () => {
    const event: ServerEvent = { type: 'message_end', id: 'm1', serverId: 'hermes', channel: 'general' }
    expect(notificationFor(event, { displayName: 'Hermes', text: 'hi' })?.title).toBe('Hermes')
  })

  it('prefers captured serverId/channel over the event for deep-link data', () => {
    // message_end may arrive without routing fields; the message_start capture wins.
    const event: ServerEvent = { type: 'message_end', id: 'm1' }
    expect(notificationFor(event, { text: 'hi', serverId: 'claude-code', channel: 'general' })?.data).toEqual({
      serverId: 'claude-code',
      channel: 'general',
    })
  })

  it('uses a generic body when no text was accumulated', () => {
    const event: ServerEvent = { type: 'message_end', id: 'm1', serverId: 'hermes' }
    expect(notificationFor(event)?.body).toBe('New message')
  })

  it('falls back to a generic title with no display name or server id', () => {
    const event: ServerEvent = { type: 'message_end', id: 'm1' }
    expect(notificationFor(event, { text: 'hi' })?.title).toBe('aji-chat')
  })

  it('uses the caption for a non-user file, or a generic fallback', () => {
    const withText: ServerEvent = { type: 'file', id: 'f1', role: 'assistant', mime: 'image/png', data: '', text: 'a chart', serverId: 'hermes' }
    expect(notificationFor(withText)).toEqual({
      title: 'hermes',
      body: 'a chart',
      data: { serverId: 'hermes', channel: undefined },
    })

    const noText: ServerEvent = { type: 'file', id: 'f2', role: 'assistant', mime: 'audio/mpeg', data: '' }
    expect(notificationFor(noText)?.body).toBe('Sent an attachment')
  })

  it('does not alert on a user-sent file', () => {
    const event: ServerEvent = { type: 'file', id: 'f1', role: 'user', mime: 'audio/mp4', data: '' }
    expect(notificationFor(event)).toBeNull()
  })

  it.each([
    { type: 'message_start', id: 'm1', role: 'assistant' },
    { type: 'text_delta', id: 'm1', text: 'hi' },
    { type: 'tool_start', id: 't1', name: 'bash', args: {} },
    { type: 'tool_end', id: 't1', result: 'ok' },
    { type: 'status', value: 'thinking' },
  ] as ServerEvent[])('returns null for non-alert event $type', (event) => {
    expect(notificationFor(event)).toBeNull()
  })
})
