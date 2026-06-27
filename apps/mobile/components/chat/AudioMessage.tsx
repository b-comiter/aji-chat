/**
 * Inline audio player for `file` items whose mime is `audio/*`.
 *
 * The bytes arrive inline as base64 (see the `file` protocol event). expo-audio
 * plays a file:// URI, so on first render we materialize the base64 into a
 * stable cache file (named by item id, written once) and hand its URI to the
 * shared player. The cache file re-materializes from the stored base64 after an
 * app restart, so history keeps playing without any server round-trip.
 *
 * Playback itself is owned by the global AudioPlayerContext (one player for the
 * whole app), not this component — so audio keeps going when the user leaves the
 * chat and a mini-player can follow them. This bubble only renders the controls
 * and reflects the shared status while it is the active track.
 */
import { useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import { writeFileToCache } from './fileCache'
import { hexToRgba } from '../colorUtils'
import { formatClock, pseudoWaveform } from './waveformHelpers'
import { WaveformScrubber } from '../audio/WaveformScrubber'
import { useAudioPlayerContext } from '../../context/AudioPlayerContext'

// Bar count for the bubble waveform; bars flex to fill the available width.
const WAVE_BARS = 40

type FileItem = Extract<Item, { kind: 'file' }>

type Props = {
  item: FileItem
  tint: boolean
  /** Source chat — threaded down so the mini-player can navigate back. */
  serverId?: string
  channelId?: string
  /** Fallback title for the mini-player (e.g. the agent/server name). */
  fallbackTitle?: string
}

export function AudioMessage({ item, tint, serverId, channelId, fallbackTitle }: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [uri, setUri] = useState<string | null>(null)

  // Guard: no payload means the agent sent an audio shell with no data.
  if (!item.data) {
    const fg = tint ? colors.userBubbleText : colors.textDim
    return <Text style={{ color: fg, fontSize: 13 }}>Audio unavailable</Text>
  }
  const { activeTrack, playing, currentTime, duration: activeDuration, play, toggle, seekTo } = useAudioPlayerContext()
  const bars = useMemo(() => pseudoWaveform(item.id, WAVE_BARS), [item.id])

  // Materialize the base64 payload to a cache file once.
  useEffect(() => {
    let cancelled = false
    writeFileToCache(item)
      .then((path) => { if (!cancelled) setUri(path) })
      .catch((err) => console.warn('[AudioMessage] failed to write cache file', err))
    return () => {
      cancelled = true
    }
  }, [item.id, item.mime, item.name, item.data])

  // This bubble reflects live playback only while it's the active track;
  // otherwise it shows a static 0 / duration resting state.
  const isActive = activeTrack?.itemId === item.id
  const duration = (isActive ? activeDuration : 0) || item.duration || 0
  const position = isActive ? currentTime : 0
  const progress = duration > 0 ? Math.min(1, position / duration) : 0
  const isPlaying = isActive && playing

  const onToggle = () => {
    if (!uri) return
    if (isActive) {
      toggle()
    } else {
      play({
        itemId: item.id,
        serverId: serverId ?? '',
        channelId: channelId ?? '',
        title: item.text?.trim() || item.name || fallbackTitle || 'Voice message',
        uri,
      })
    }
  }

  // On the user's own (tinted) bubble, foreground = userBubbleText — the same
  // contrast-matched ink the bubble's text uses (dark on the gold palettes,
  // white on the blue ones). Plain '#fff' washed out against gold.
  const fg = tint ? colors.userBubbleText : colors.text
  const accent = tint ? colors.userBubbleText : colors.accent
  // Unplayed waveform bars — dim but still legible against the bubble.
  const track = tint ? hexToRgba(colors.userBubbleText, 0.3) : colors.borderAlt
  const loading = !uri

  return (
    <View>
      <View style={styles.row}>
        <Pressable
          onPress={onToggle}
          disabled={loading}
          style={[styles.playButton, { borderColor: accent, opacity: loading ? 0.5 : 1 }]}
          hitSlop={8}
        >
          <Feather
            name={isPlaying ? 'pause' : 'play'}
            size={18}
            color={accent}
            style={isPlaying ? undefined : styles.playGlyphOffset}
          />
        </Pressable>
        <View style={styles.meta}>
          <WaveformScrubber
            bars={bars}
            progress={progress}
            durationSec={duration}
            onSeek={isActive && duration > 0 ? (f) => seekTo(f * duration) : undefined}
            playedColor={accent}
            unplayedColor={track}
            knobColor={accent}
            tipBg={accent}
            tipText={tint ? colors.userBubbleBg : colors.bg}
            height={26}
          />
          <View style={styles.timeRow}>
            <Text style={[styles.time, { color: fg }]}>{formatClock(position)}</Text>
            <Text style={[styles.time, { color: fg }]}>{formatClock(duration)}</Text>
          </View>
        </View>
      </View>
      {item.text ? <Text style={[styles.caption, { color: fg }]}>{item.text}</Text> : null}
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minWidth: 200 },
    playButton: {
      width: 40,
      height: 40,
      borderRadius: radius.full,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // The play triangle reads as off-center inside a circle; nudge it right.
    playGlyphOffset: { marginLeft: 2 },
    meta: { flex: 1 },
    timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
    time: { fontSize: typography.sizeSm, fontVariant: ['tabular-nums'] },
    caption: { marginTop: spacing.sm, fontSize: typography.sizeLg, lineHeight: typography.lineHeightNormal },
  })
}
