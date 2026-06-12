import { MAX_BARS, normalizeDb, pushSample } from './waveformHelpers'

describe('normalizeDb', () => {
  test('null input returns a tiny non-zero baseline', () => {
    expect(normalizeDb(null)).toBeGreaterThan(0)
    expect(normalizeDb(null)).toBeLessThan(0.1)
  })

  test('clamps the silence floor at the baseline', () => {
    expect(normalizeDb(-160)).toBe(normalizeDb(null))
    expect(normalizeDb(-60)).toBe(normalizeDb(null))
  })

  test('clamps the loud end at 1', () => {
    expect(normalizeDb(0)).toBe(1)
    expect(normalizeDb(10)).toBe(1)
  })

  test('maps -30 dB to ~0.5', () => {
    expect(normalizeDb(-30)).toBeCloseTo(0.5, 2)
  })

  test('rejects NaN / Infinity', () => {
    expect(normalizeDb(NaN)).toBe(normalizeDb(null))
    expect(normalizeDb(Infinity)).toBe(normalizeDb(null))
  })
})

describe('pushSample', () => {
  test('appends to a short history', () => {
    expect(pushSample([0.1, 0.2], 0.3)).toEqual([0.1, 0.2, 0.3])
  })

  test('drops the oldest sample when at the cap', () => {
    const full = Array.from({ length: MAX_BARS }, (_, i) => i / MAX_BARS)
    const next = pushSample(full, 999)
    expect(next).toHaveLength(MAX_BARS)
    expect(next[MAX_BARS - 1]).toBe(999)
    expect(next[0]).toBe(full[1]) // earliest sample dropped
  })

  test('respects a custom max', () => {
    const next = pushSample([1, 2, 3, 4], 5, 3)
    expect(next).toEqual([3, 4, 5])
  })

  test('does not mutate the input array', () => {
    const input = [0.1, 0.2]
    pushSample(input, 0.3)
    expect(input).toEqual([0.1, 0.2])
  })
})
