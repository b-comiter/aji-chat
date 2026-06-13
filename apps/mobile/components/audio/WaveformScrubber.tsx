/**
 * Waveform progress + scrubber for audio playback. Renders amplitude bars that
 * fill (played vs unplayed) with the position, plus — when `onSeek` is given — a
 * draggable grab handle and a time bubble that tracks the finger while scrubbing.
 *
 * Built on core RN PanResponder (no gesture-handler dependency). Bars flex to
 * fill the available width so the touch x-fraction maps directly to a seek
 * position. When `onSeek` is omitted the bar is purely presentational.
 */
import { useMemo, useRef, useState } from 'react'
import { PanResponder, StyleSheet, Text, View } from 'react-native'
import { formatClock } from '../chat/waveformHelpers'

const BAR_GAP = 2
const MIN_BAR = 3
const KNOB = 13
const KNOB_ACTIVE = 18

type Props = {
  /** Amplitudes 0..1 (e.g. from pseudoWaveform). */
  bars: number[]
  /** Playback position 0..1. */
  progress: number
  /** Clip length (seconds) — drives the scrub time bubble. */
  durationSec: number
  /** Seek target 0..1 on tap/drag. Omit = static, non-interactive. */
  onSeek?: (fraction: number) => void
  playedColor: string
  unplayedColor: string
  knobColor: string
  /** Time-bubble colors (defaults: knobColor bg, dark text). */
  tipBg?: string
  tipText?: string
  height?: number
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export function WaveformScrubber({
  bars,
  progress,
  durationSec,
  onSeek,
  playedColor,
  unplayedColor,
  knobColor,
  tipBg,
  tipText,
  height = 24,
}: Props) {
  const widthRef = useRef(0)
  const [scrub, setScrub] = useState<number | null>(null)
  const interactive = !!onSeek

  const pan = useMemo(() => {
    const frac = (x: number) => (widthRef.current > 0 ? clamp01(x / widthRef.current) : 0)
    return PanResponder.create({
      onStartShouldSetPanResponder: () => interactive,
      onMoveShouldSetPanResponder: () => interactive,
      onPanResponderGrant: (e) => { const f = frac(e.nativeEvent.locationX); setScrub(f); onSeek?.(f) },
      onPanResponderMove: (e) => { const f = frac(e.nativeEvent.locationX); setScrub(f); onSeek?.(f) },
      onPanResponderRelease: (e) => { onSeek?.(frac(e.nativeEvent.locationX)); setScrub(null) },
      onPanResponderTerminate: () => setScrub(null),
      onPanResponderTerminationRequest: () => false,
    })
  }, [interactive, onSeek])

  const shown = scrub != null ? scrub : clamp01(progress)
  const scrubbing = scrub != null
  const knobSize = scrubbing ? KNOB_ACTIVE : KNOB

  return (
    <View
      style={[styles.wrap, { height }]}
      onLayout={(e) => { widthRef.current = e.nativeEvent.layout.width }}
      {...(interactive ? pan.panHandlers : {})}
    >
      <View style={[styles.bars, { height }]}>
        {bars.map((a, i) => {
          const played = bars.length > 0 && (i + 0.5) / bars.length <= shown
          return (
            <View
              key={i}
              style={{
                flex: 1,
                marginLeft: i === 0 ? 0 : BAR_GAP,
                height: Math.max(MIN_BAR, Math.round(a * height)),
                borderRadius: 2,
                backgroundColor: played ? playedColor : unplayedColor,
              }}
            />
          )
        })}
      </View>

      {interactive ? (
        <View
          pointerEvents="none"
          style={[
            styles.knob,
            {
              left: `${shown * 100}%`,
              width: knobSize,
              height: knobSize,
              borderRadius: knobSize / 2,
              marginLeft: -knobSize / 2,
              marginTop: -knobSize / 2,
              backgroundColor: knobColor,
            },
          ]}
        />
      ) : null}

      {interactive && scrubbing ? (
        <View pointerEvents="none" style={[styles.tipAnchor, { left: `${shown * 100}%` }]}>
          <View style={[styles.tip, { backgroundColor: tipBg ?? knobColor }]}>
            <Text style={[styles.tipText, { color: tipText ?? '#0F172A' }]}>
              {formatClock(shown * durationSec)}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', justifyContent: 'center' },
  bars: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  knob: { position: 'absolute', top: '50%' },
  tipAnchor: { position: 'absolute', bottom: '100%', marginBottom: 7 },
  // Fixed width + negative half-margin centers the bubble over the handle.
  tip: { width: 44, marginLeft: -22, alignItems: 'center', paddingVertical: 2, borderRadius: 7 },
  tipText: { fontSize: 11, fontWeight: '500', fontVariant: ['tabular-nums'] },
})
