import { clamp, sameOrder, moveKey } from './DraggableList'

describe('clamp', () => {
  it('bounds a value within the range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })
})

describe('sameOrder', () => {
  it('is true only for identical sequences', () => {
    expect(sameOrder(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true)
    expect(sameOrder(['a', 'b', 'c'], ['a', 'c', 'b'])).toBe(false)
    expect(sameOrder(['a', 'b'], ['a', 'b', 'c'])).toBe(false)
  })
})

describe('moveKey', () => {
  const base = ['a', 'b', 'c', 'd']

  it('moves a key down to a later slot', () => {
    expect(moveKey(base, 'a', 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves a key up to an earlier slot', () => {
    expect(moveKey(base, 'd', 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('is a no-op when the key is already at the target', () => {
    expect(moveKey(base, 'b', 1)).toEqual(base)
  })

  it('clamps an out-of-range target to the ends', () => {
    expect(moveKey(base, 'a', 99)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveKey(base, 'd', -5)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('returns a fresh copy when the key is absent', () => {
    const result = moveKey(base, 'z', 1)
    expect(result).toEqual(base)
    expect(result).not.toBe(base)
  })

  it('preserves length', () => {
    expect(moveKey(base, 'c', 0)).toHaveLength(base.length)
  })
})
