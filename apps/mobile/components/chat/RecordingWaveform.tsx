/**
 * Live amplitude waveform shown inside the composer during voice recording
 * and in the review state after recording stops.
 *
 * Two modes:
 *  - `live`: receives a stream of dB samples via the `db` prop and appends a
 *    new bar on each tick. Bars are plain Views — no Reanimated overhead needed
 *    since the whole list re-renders each frame anyway.
 *  - `static`: receives a precomputed amplitude history (0..1). On mount the
 *    bars stagger in with a left-to-right scale-up animation (Reanimated).
 *    When `progress` (0..1) is supplied, bars before the playhead are colored
 *    `accent` and bars after are `accentDim`, giving a scrub-position visual.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { useTheme } from '../../context/ThemeContext'
import { MAX_BARS, normalizeDb, pushSample } from './waveformHelpers'

// ─── Types ────────────────────────────────────────────────────────────────────

interface LiveProps {
  db: number | null
  tick: number
  staticBars?: never
  progress?: never
}

interface StaticProps {
  staticBars: number[]
  /** 0..1 playback position — bars before this fraction are accented */
  progress?: number
  db?: never
  tick?: never
}

type Props = (LiveProps | StaticProps) & { height?: number }

// ─── Constants ────────────────────────────────────────────────────────────────

const BAR_WIDTH = 3
const BAR_GAP = 2
const MIN_BAR_HEIGHT = 3

// ─── Animated bar (static / review mode only) ─────────────────────────────────
//
// One component per bar so each can derive its own animated style from the
// single shared `phase` value using a worklet — no per-bar shared values needed.
//
// Animation math:
//   phase goes 0 → 1 over 500 ms.
//   Bar i starts growing when phase > (i / total) * 0.7   (stagger offset)
//   Bar i finishes growing when the above + 0.3 has elapsed  (30% of total range)
//   Result: bar 0 enters immediately, last bar finishes at phase ≈ 1.0 (500 ms).

interface WaveformBarProps {
  index: number
  amplitude: number
  containerHeight: number
  color: string
  phase: SharedValue<number>
  totalBars: number
}

function WaveformBar({ index, amplitude, containerHeight, color, phase, totalBars }: WaveformBarProps) {
  const barH = Math.max(MIN_BAR_HEIGHT, Math.round(amplitude * containerHeight))
  const style = useAnimatedStyle(() => {
    if (totalBars === 0) return { height: barH }
    const start = (index / totalBars) * 0.7
    const p = Math.min(1, Math.max(0, (phase.value - start) / 0.3))
    return { height: barH * p }
  })
  return (
    <Animated.View
      style={[
        {
          width: BAR_WIDTH,
          marginLeft: index === 0 ? 0 : BAR_GAP,
          borderRadius: BAR_WIDTH / 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RecordingWaveform(props: Props) {
  const { colors } = useTheme()
  const height = props.height ?? 28

  // Live-mode bar history
  const [history, setHistory] = useState<number[]>([])
  const lastTickRef = useRef<number>(-1)

  // Stagger animation for static/review bars
  const phase = useSharedValue(0)

  const isStatic = 'staticBars' in props && props.staticBars != null
  const tick = !isStatic ? (props as LiveProps).tick : undefined
  const staticLen = isStatic ? ((props as StaticProps).staticBars?.length ?? 0) : 0

  // Live mode: push one bar per tick
  useEffect(() => {
    if (isStatic || tick === undefined || tick === lastTickRef.current) return
    lastTickRef.current = tick
    setHistory((prev) => pushSample(prev, normalizeDb((props as LiveProps).db)))
  }, [tick, isStatic])

  // Static mode: reset live history when entering review
  useEffect(() => {
    if (isStatic) {
      setHistory([])
      lastTickRef.current = -1
    }
  }, [isStatic])

  // Stagger animation: fires whenever static bars first populate (len 0 → N)
  useEffect(() => {
    if (staticLen === 0) {
      phase.value = 0
      return
    }
    phase.value = 0
    phase.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) })
  }, [staticLen, phase])

  const rawBars = isStatic ? ((props as StaticProps).staticBars ?? []) : history
  const progress = isStatic ? ((props as StaticProps).progress ?? 0) : 0
  const totalBars = rawBars.length
  const visible = useMemo(
    () => (rawBars.length > MAX_BARS ? rawBars.slice(rawBars.length - MAX_BARS) : rawBars),
    [rawBars],
  )
  const visibleOffset = totalBars - visible.length

  return (
    <View
      style={[styles.row, { height }]}
      accessibilityRole="image"
      accessibilityLabel={isStatic ? 'Recorded waveform' : 'Recording waveform'}
    >
      {isStatic
        ? visible.map((amp, i) => {
            const isPlayed = totalBars > 0 && (visibleOffset + i) / totalBars < progress
            return (
              <WaveformBar
                key={i}
                index={i}
                amplitude={amp}
                containerHeight={height}
                color={isPlayed ? colors.accent : colors.accentDim}
                phase={phase}
                totalBars={visible.length}
              />
            )
          })
        : visible.map((amp, i) => {
            const h = Math.max(MIN_BAR_HEIGHT, Math.round(amp * height))
            return (
              <View
                key={i}
                style={{
                  width: BAR_WIDTH,
                  height: h,
                  marginLeft: i === 0 ? 0 : BAR_GAP,
                  borderRadius: BAR_WIDTH / 2,
                  backgroundColor: colors.accent,
                }}
              />
            )
          })}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    overflow: 'hidden',
    flex: 1,
  },
})
