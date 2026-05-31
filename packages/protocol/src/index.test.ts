import { fileMessage, newId, textMessage } from './index'

describe('newId', () => {
  test('uses the provided prefix', () => {
    const id = newId('msg')
    expect(id.startsWith('msg_')).toBe(true)
  })

  test('defaults to "id" when no prefix is given', () => {
    const id = newId()
    expect(id.startsWith('id_')).toBe(true)
  })

  test('produces a monotonically increasing counter suffix', () => {
    const a = newId('x')
    const b = newId('x')
    const c = newId('x')
    const counter = (s: string) => Number(s.split('_').pop())
    expect(counter(b)).toBeGreaterThan(counter(a))
    expect(counter(c)).toBeGreaterThan(counter(b))
  })

  test('different calls produce different ids even within the same ms', () => {
    const ids = Array.from({ length: 50 }, () => newId('z'))
    expect(new Set(ids).size).toBe(50)
  })
})

describe('textMessage', () => {
  test('returns exactly start / delta / end in order', () => {
    const events = textMessage('hello')
    expect(events).toHaveLength(3)
    expect(events[0].type).toBe('message_start')
    expect(events[1].type).toBe('text_delta')
    expect(events[2].type).toBe('message_end')
  })

  test('all three events share the same id', () => {
    const [start, delta, end] = textMessage('hi')
    expect(start.id).toBe(delta.id)
    expect(delta.id).toBe(end.id)
  })

  test('defaults role to assistant', () => {
    const [start] = textMessage('hi') as [{ type: 'message_start'; role: string }]
    expect(start.role).toBe('assistant')
  })

  test('respects an explicit role', () => {
    const [start] = textMessage('hi', 'system') as [{ type: 'message_start'; role: string }]
    expect(start.role).toBe('system')
  })

  test('text payload is on the delta event', () => {
    const [, delta] = textMessage('the quick brown fox') as [unknown, { text: string }]
    expect(delta.text).toBe('the quick brown fox')
  })

  test('propagates turn_id to all three events when provided', () => {
    const events = textMessage('hi', 'assistant', 'turn-123')
    for (const event of events) {
      // every event in this tuple should carry the turn_id
      expect((event as { turn_id?: string }).turn_id).toBe('turn-123')
    }
  })

  test('omits turn_id entirely when not provided', () => {
    const events = textMessage('hi')
    for (const event of events) {
      expect('turn_id' in event).toBe(false)
    }
  })
})

describe('fileMessage', () => {
  test('produces a single file event with a file_ id', () => {
    const event = fileMessage('audio/mpeg', 'AAAA')
    expect(event.type).toBe('file')
    expect(event.id.startsWith('file_')).toBe(true)
  })

  test('carries the mime and base64 data', () => {
    const event = fileMessage('audio/ogg', 'T2dnUw==')
    expect(event.mime).toBe('audio/ogg')
    expect(event.data).toBe('T2dnUw==')
  })

  test('defaults role to assistant', () => {
    expect(fileMessage('audio/mpeg', 'AAAA').role).toBe('assistant')
  })

  test('respects an explicit role', () => {
    expect(fileMessage('audio/mpeg', 'AAAA', { role: 'user' }).role).toBe('user')
  })

  test('includes optional metadata when provided', () => {
    const event = fileMessage('audio/mpeg', 'AAAA', {
      name: 'clip.mp3',
      duration: 1.5,
      text: 'a caption',
      turn_id: 'turn-9',
      agent: 'simulate',
    })
    expect(event.name).toBe('clip.mp3')
    expect(event.duration).toBe(1.5)
    expect(event.text).toBe('a caption')
    expect(event.turn_id).toBe('turn-9')
    expect(event.agent).toBe('simulate')
  })

  test('omits optional fields entirely when not provided', () => {
    const event = fileMessage('audio/mpeg', 'AAAA')
    expect('name' in event).toBe(false)
    expect('duration' in event).toBe(false)
    expect('text' in event).toBe(false)
    expect('turn_id' in event).toBe(false)
    expect('agent' in event).toBe(false)
  })
})
