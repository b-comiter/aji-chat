/**
 * Pure date/time formatting for the chat timeline — per-message clock times and
 * the "Today / Yesterday / March 3" day separators. Kept side-effect-free and
 * colocated with a test (see timeHelpers.test.ts).
 */

const DAY_MS = 86_400_000

/** Local midnight (epoch ms) for the day containing `ms`. */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Whether two epoch-ms timestamps fall on the same local calendar day. */
export function sameCalendarDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b)
}

/** Short clock time for a message bubble, e.g. "3:42 PM" (locale-dependent). */
export function formatMessageTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Label for a day-separator row: "Today" / "Yesterday" for the recent days,
 * "March 3" within the current year, else "March 3, 2026". `now` is injectable
 * for testing.
 */
export function formatDaySeparator(ms: number, now: number = Date.now()): string {
  const day = startOfLocalDay(ms)
  const today = startOfLocalDay(now)
  if (day === today) return 'Today'
  if (day === today - DAY_MS) return 'Yesterday'
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear()
  return new Date(ms).toLocaleDateString(
    [],
    sameYear ? { month: 'long', day: 'numeric' } : { month: 'long', day: 'numeric', year: 'numeric' },
  )
}
