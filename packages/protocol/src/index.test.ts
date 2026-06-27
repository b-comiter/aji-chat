import type { ClientEvent, ServerEvent } from './index'
import { fileMessage, newId, textMessage, userFileMessage } from './index'

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

  test('propagates serverId and channel to all three events when provided', () => {
    const events = textMessage('hi', 'assistant', undefined, { serverId: 'hermes', channel: 'daily-brief' })
    for (const event of events) {
      expect((event as { serverId?: string }).serverId).toBe('hermes')
      expect((event as { channel?: string }).channel).toBe('daily-brief')
    }
  })

  test('omits serverId and channel entirely when not provided', () => {
    const events = textMessage('hi')
    for (const event of events) {
      expect('serverId' in event).toBe(false)
      expect('channel' in event).toBe(false)
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
      serverId: 'simulate',
      channel: 'general',
    })
    expect(event.name).toBe('clip.mp3')
    expect(event.duration).toBe(1.5)
    expect(event.text).toBe('a caption')
    expect(event.turn_id).toBe('turn-9')
    expect(event.serverId).toBe('simulate')
    expect(event.channel).toBe('general')
  })

  test('omits optional fields entirely when not provided', () => {
    const event = fileMessage('audio/mpeg', 'AAAA')
    expect('name' in event).toBe(false)
    expect('duration' in event).toBe(false)
    expect('text' in event).toBe(false)
    expect('turn_id' in event).toBe(false)
    expect('serverId' in event).toBe(false)
    expect('channel' in event).toBe(false)
  })
})

describe('userFileMessage', () => {
  test('produces a user_file event with the mime and data', () => {
    const event = userFileMessage('audio/mp4', 'AAAA')
    expect(event.type).toBe('user_file')
    expect(event.mime).toBe('audio/mp4')
    expect(event.data).toBe('AAAA')
  })

  test('includes optional metadata when provided', () => {
    const event = userFileMessage('audio/mp4', 'AAAA', {
      name: 'voice-message.m4a',
      duration: 4.2,
      text: 'caption',
      serverId: 'hermes',
      channel: 'planning',
    })
    expect(event.name).toBe('voice-message.m4a')
    expect(event.duration).toBe(4.2)
    expect(event.text).toBe('caption')
    expect(event.serverId).toBe('hermes')
    expect(event.channel).toBe('planning')
  })

  test('omits optional fields entirely when not provided', () => {
    const event = userFileMessage('audio/mp4', 'AAAA')
    expect('name' in event).toBe(false)
    expect('duration' in event).toBe(false)
    expect('text' in event).toBe(false)
    expect('serverId' in event).toBe(false)
    expect('channel' in event).toBe(false)
  })

  test('narrows correctly inside a ClientEvent discriminated union', () => {
    const event: ClientEvent = userFileMessage('audio/mp4', 'AAAA', { duration: 1.0 })
    // The discriminant should narrow the union to UserFile, exposing the mime field
    if (event.type === 'user_file') {
      expect(event.mime).toBe('audio/mp4')
      expect(event.duration).toBe(1.0)
    } else {
      throw new Error('expected user_file discriminant')
    }
  })
})

describe('ServerInfo / ServerEvent identity fields', () => {
  test('ServerInfo narrows in a ServerEvent union and carries monoChannel', () => {
    const event: ServerEvent = {
      type: 'server_info',
      serverId: 'claude-code',
      monoChannel: true,
      displayName: 'Claude Code',
    }
    if (event.type === 'server_info') {
      expect(event.serverId).toBe('claude-code')
      expect(event.monoChannel).toBe(true)
      expect(event.displayName).toBe('Claude Code')
    } else {
      throw new Error('expected server_info discriminant')
    }
  })

  test('events carry distinct serverId and agentId', () => {
    const event: ServerEvent = {
      type: 'message_start',
      id: 'm1',
      role: 'assistant',
      serverId: 'hermes',
      agentId: 'agent_abc',
      channel: 'general',
    }
    expect(event.serverId).toBe('hermes')
    expect(event.agentId).toBe('agent_abc')
  })
})

describe('ClearChannel', () => {
  test('narrows in a ClientEvent union and carries serverId + channel', () => {
    const event: ClientEvent = {
      type: 'clear_channel',
      serverId: 'hermes',
      channel: 'daily-brief',
    }
    if (event.type === 'clear_channel') {
      expect(event.serverId).toBe('hermes')
      expect(event.channel).toBe('daily-brief')
    } else {
      throw new Error('expected clear_channel discriminant')
    }
  })

  test('serverId and channel are optional', () => {
    const event: ClientEvent = { type: 'clear_channel' }
    expect(event.type).toBe('clear_channel')
  })
})

describe('per-session channel fields', () => {
  test('CreateChannel carries an optional cwd', () => {
    const event: ClientEvent = {
      type: 'create_channel',
      serverId: 'claude-code',
      channel: 'feature-x',
      displayName: 'Feature X',
      cwd: '/Users/me/dev/feature-x',
    }
    if (event.type === 'create_channel') {
      expect(event.cwd).toBe('/Users/me/dev/feature-x')
    } else {
      throw new Error('expected create_channel discriminant')
    }
  })

  test('GetSessions narrows and carries serverId', () => {
    const event: ClientEvent = { type: 'get_sessions', serverId: 'claude-code' }
    if (event.type === 'get_sessions') {
      expect(event.serverId).toBe('claude-code')
    } else {
      throw new Error('expected get_sessions discriminant')
    }
  })

  test('Sessions narrows in a ServerEvent union and carries liveChannels', () => {
    const event: ServerEvent = {
      type: 'sessions',
      serverId: 'claude-code',
      liveChannels: ['general', 'feature-x'],
    }
    if (event.type === 'sessions') {
      expect(event.serverId).toBe('claude-code')
      expect(event.liveChannels).toEqual(['general', 'feature-x'])
    } else {
      throw new Error('expected sessions discriminant')
    }
  })
})
