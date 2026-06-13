import { sameCalendarDay, formatDaySeparator } from './timeHelpers'

// Fixed reference "now": Wed Jun 10 2026, 14:30 local time.
const NOW = new Date(2026, 5, 10, 14, 30).getTime()
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime()

describe('sameCalendarDay', () => {
  test('true for different times on the same day', () => {
    expect(sameCalendarDay(at(2026, 5, 10, 1), at(2026, 5, 10, 23))).toBe(true)
  })
  test('false across a midnight boundary', () => {
    expect(sameCalendarDay(at(2026, 5, 10, 23), at(2026, 5, 11, 0))).toBe(false)
  })
})

describe('formatDaySeparator', () => {
  test('labels today and yesterday', () => {
    expect(formatDaySeparator(at(2026, 5, 10, 9), NOW)).toBe('Today')
    expect(formatDaySeparator(at(2026, 5, 9, 9), NOW)).toBe('Yesterday')
  })
  test('omits the year within the current year', () => {
    expect(formatDaySeparator(at(2026, 2, 3), NOW)).toBe('March 3')
  })
  test('includes the year for a prior year', () => {
    expect(formatDaySeparator(at(2025, 2, 3), NOW)).toBe('March 3, 2025')
  })
})
