import { removeChannelInfo, upsertChannelInfo } from './channels'

describe('upsertChannelInfo', () => {
  it('appends a new channel', () => {
    expect(upsertChannelInfo([], 'general')).toEqual([{ id: 'general' }])
  })

  it('is idempotent on id — re-creating does not duplicate the row', () => {
    expect(upsertChannelInfo([{ id: 'general' }], 'general')).toEqual([{ id: 'general' }])
  })

  it('refreshes displayName when a new one is provided', () => {
    expect(upsertChannelInfo([{ id: 'general' }], 'general', 'General')).toEqual([
      { id: 'general', displayName: 'General' },
    ])
  })

  it('keeps an existing displayName when none is provided', () => {
    expect(upsertChannelInfo([{ id: 'general', displayName: 'General' }], 'general')).toEqual([
      { id: 'general', displayName: 'General' },
    ])
  })

  it('preserves order and appends unknown channels at the end', () => {
    const list = upsertChannelInfo([{ id: 'a' }, { id: 'b' }], 'c')
    expect(list.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('stores cwd on a new channel', () => {
    expect(upsertChannelInfo([], 'feature-x', 'Feature X', '/dev/feature-x')).toEqual([
      { id: 'feature-x', displayName: 'Feature X', cwd: '/dev/feature-x' },
    ])
  })

  it('refreshes cwd when a new one is provided, keeps it otherwise', () => {
    const withCwd = upsertChannelInfo([{ id: 'a', cwd: '/old' }], 'a', undefined, '/new')
    expect(withCwd).toEqual([{ id: 'a', cwd: '/new' }])
    const kept = upsertChannelInfo([{ id: 'a', cwd: '/new' }], 'a')
    expect(kept).toEqual([{ id: 'a', cwd: '/new' }])
  })
})

describe('removeChannelInfo', () => {
  it('removes the named channel', () => {
    expect(removeChannelInfo([{ id: 'a' }, { id: 'b' }], 'a')).toEqual([{ id: 'b' }])
  })

  it('is a no-op for an unknown channel', () => {
    expect(removeChannelInfo([{ id: 'a' }], 'missing')).toEqual([{ id: 'a' }])
  })

  it('returns a new array (does not mutate the input)', () => {
    const input = [{ id: 'a' }, { id: 'b' }]
    const out = removeChannelInfo(input, 'a')
    expect(input).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(out).not.toBe(input)
  })
})
