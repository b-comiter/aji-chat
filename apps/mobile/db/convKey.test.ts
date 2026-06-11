import { convKey, parseConvKey } from './convKey'

describe('convKey', () => {
  test('composes server and channel', () => {
    expect(convKey('hermes', 'daily-brief')).toBe('hermes/daily-brief')
  })

  test('defaults the channel to "general"', () => {
    expect(convKey('hermes')).toBe('hermes/general')
  })
})

describe('parseConvKey', () => {
  test('round-trips a composed key', () => {
    expect(parseConvKey(convKey('hermes', 'daily-brief'))).toEqual({
      server: 'hermes',
      channel: 'daily-brief',
    })
  })

  test('treats a bare server id (no separator) as the default channel', () => {
    expect(parseConvKey('claude-code')).toEqual({
      server: 'claude-code',
      channel: 'general',
    })
  })

  test('preserves slashes within the channel segment', () => {
    expect(parseConvKey('hermes/team/standup')).toEqual({
      server: 'hermes',
      channel: 'team/standup',
    })
  })

  test('empty channel segment falls back to default', () => {
    expect(parseConvKey('hermes/')).toEqual({ server: 'hermes', channel: 'general' })
  })
})
