/**
 * Pure helpers for the recording waveform. Kept separate from the component so
 * they can be unit-tested without React Native renderer plumbing.
 */

/** Cap how many bars we keep in the rolling history — bounds memory. */
export const MAX_BARS = 120

/** dB floor below which we treat the input as silence. */
export const DB_SILENCE_FLOOR = -60

/**
 * Map a metering value in dB (~-160..0) to a normalized amplitude (0..1).
 * `null` (no metering yet) becomes a tiny non-zero so the bar is still visible
 * but minimal, matching how WhatsApp shows the first sliver as you start.
 */
export function normalizeDb(db: number | null): number {
  if (db == null || !Number.isFinite(db)) return 0.04
  if (db <= DB_SILENCE_FLOOR) return 0.04
  if (db >= 0) return 1
  return (db - DB_SILENCE_FLOOR) / -DB_SILENCE_FLOOR
}

/** Append `sample` and trim to MAX_BARS, keeping the most recent samples. */
export function pushSample(history: number[], sample: number, max = MAX_BARS): number[] {
  const next = history.length >= max ? history.slice(history.length - max + 1) : history.slice()
  next.push(sample)
  return next
}

/**
 * Reduce `bars` to at most `maxBars` by averaging adjacent groups.
 * When bars.length <= maxBars the original array is returned unchanged.
 * Used to convert a full recording's bar history into the fixed display width
 * so that progress sweeps left-to-right across the entire duration.
 */
export function downsampleBars(bars: number[], maxBars: number = MAX_BARS): number[] {
  if (bars.length <= maxBars) return bars
  const factor = bars.length / maxBars
  const result: number[] = []
  for (let i = 0; i < maxBars; i++) {
    const start = Math.floor(i * factor)
    const end = Math.floor((i + 1) * factor)
    let sum = 0
    for (let j = start; j < end; j++) sum += bars[j]
    result.push(sum / (end - start))
  }
  return result
}
