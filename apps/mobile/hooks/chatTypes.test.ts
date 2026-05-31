import { ensureMessageExists } from './chatTypes'
import type { Item } from './chatTypes'

describe('ensureMessageExists', () => {
  const existing: Item = {
    kind: 'message', id: 'msg-1', role: 'assistant', text: 'hello', done: false,
  }

  test('appends a placeholder when the message is missing', () => {
    const result = ensureMessageExists([], 'new-id', undefined)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'message', id: 'new-id', role: 'assistant', text: '', done: false,
    })
  })

  test('attaches the turnId when provided', () => {
    const [created] = ensureMessageExists([], 'new-id', 'turn-7')
    if (created.kind !== 'message') throw new Error('expected message')
    expect(created.turnId).toBe('turn-7')
  })

  test('returns the same array reference when the message is already present', () => {
    const items: Item[] = [existing]
    const result = ensureMessageExists(items, 'msg-1', undefined)
    // Identity check — important for React re-render avoidance.
    expect(result).toBe(items)
  })

  test('does not match an id of a different kind (tool/prompt)', () => {
    const items: Item[] = [
      { kind: 'tool', id: 'shared-id', name: 'bash', args: {}, done: false },
    ]
    // Tool with the same id should NOT count as the message existing.
    const result = ensureMessageExists(items, 'shared-id', undefined)
    expect(result).toHaveLength(2)
    expect(result[1].kind).toBe('message')
  })

  test('preserves the existing order when appending', () => {
    const a: Item = { kind: 'message', id: 'a', role: 'user', text: 'first', done: true }
    const b: Item = { kind: 'tool', id: 'b', name: 'bash', args: {}, done: true }
    const result = ensureMessageExists([a, b], 'c', undefined)
    expect(result.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})
