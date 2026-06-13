/**
 * Telegram-style "now playing" bar. Floats at the top of every screen whenever a
 * voice clip is playing (driven by the global AudioPlayerContext), so playback
 * follows the user as they navigate. Tapping the body jumps back to the source
 * chat; the X stops playback and dismisses the bar.
 *
 * Rendered once as a top overlay in app/_layout.tsx. It overlays the very top of
 * whatever screen is showing; AppHeader adds matching top padding when a track is
 * active so headers aren't covered (the two share MINI_PLAYER_BAR_HEIGHT).
 */
import { useMemo, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Feather } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import type { ThemeColors } from '../../constants/theme'
import { spacing, typography, radius } from '../../constants/theme'
import { useAudioPlayerContext, PLAYBACK_RATES } from '../../context/AudioPlayerContext'
import { WaveformScrubber } from './WaveformScrubber'
import { formatClock, pseudoWaveform } from '../chat/waveformHelpers'

/** Height of the bar's content row (excludes the status-bar safe-area inset).
 *  Taller than a plain bar — the C1 layout stacks title · waveform · times. */
export const MINI_PLAYER_BAR_HEIGHT = 76

// Bar count for the header waveform; bars flex to fill the available width.
const WAVE_BARS = 44

const formatRate = (r: number) => `${r}×`

export function MiniPlayer() {
  const { colors } = useTheme()
  const { top: safeTop } = useSafeAreaInsets()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { activeTrack, playing, currentTime, duration, rate, setRate, toggle, seekTo, stop } = useAudioPlayerContext()
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false)
  const bars = useMemo(() => pseudoWaveform(activeTrack?.itemId ?? '', WAVE_BARS), [activeTrack?.itemId])

  if (!activeTrack) return null

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0

  const goToChat = () => {
    router.push(`/chat/${activeTrack.serverId}/${activeTrack.channelId}`)
  }

  return (
    <View style={[styles.container, { paddingTop: safeTop }]} pointerEvents="box-none">
      <View style={[styles.bar, { height: MINI_PLAYER_BAR_HEIGHT }]}>
        <Pressable
          onPress={toggle}
          hitSlop={8}
          style={styles.playBtn}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
        >
          <Feather
            name={playing ? 'pause' : 'play'}
            size={18}
            color={colors.accent}
            style={playing ? undefined : styles.playGlyphOffset}
          />
        </Pressable>

        <View style={styles.body}>
          <Pressable
            onPress={goToChat}
            accessibilityRole="button"
            accessibilityLabel={`Now playing: ${activeTrack.title}. Tap to open chat.`}
          >
            <Text style={styles.title} numberOfLines={1}>{activeTrack.title}</Text>
          </Pressable>
          <WaveformScrubber
            bars={bars}
            progress={progress}
            durationSec={duration}
            onSeek={duration > 0 ? (f) => seekTo(f * duration) : undefined}
            playedColor={colors.accent}
            unplayedColor={colors.borderAlt}
            knobColor={colors.accent}
            tipBg={colors.accent}
            tipText={colors.bg}
            height={20}
          />
          <View style={styles.timeRow}>
            <Text style={styles.timeText}>{formatClock(currentTime)}</Text>
            <Text style={styles.timeText}>{formatClock(duration)}</Text>
          </View>
        </View>

        <Pressable
          onPress={() => setSpeedMenuOpen(true)}
          hitSlop={8}
          style={styles.speedChip}
          accessibilityRole="button"
          accessibilityLabel={`Playback speed ${formatRate(rate)}. Tap to change.`}
        >
          <Text style={styles.speedChipText}>{formatRate(rate)}</Text>
        </Pressable>

        <Pressable
          onPress={stop}
          hitSlop={8}
          style={styles.closeBtn}
          accessibilityRole="button"
          accessibilityLabel="Stop playback"
        >
          <Feather name="x" size={20} color={colors.textDim} />
        </Pressable>
      </View>

      {/* Speed dropdown — anchored under the chip near the right edge. */}
      <Modal visible={speedMenuOpen} transparent animationType="fade" onRequestClose={() => setSpeedMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setSpeedMenuOpen(false)}>
          <View style={[styles.menu, { top: safeTop + MINI_PLAYER_BAR_HEIGHT - 2 }]}>
            {PLAYBACK_RATES.map((r) => {
              const active = r === rate
              return (
                <Pressable
                  key={r}
                  style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                  onPress={() => { setRate(r); setSpeedMenuOpen(false) }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.menuItemText, active && styles.menuItemTextActive]}>{formatRate(r)}</Text>
                  {active ? <Feather name="check" size={15} color={colors.accent} /> : null}
                </Pressable>
              )
            })}
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 100,
      elevation: 100,
      backgroundColor: colors.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      gap: spacing.md,
    },
    playBtn: {
      width: 34,
      height: 34,
      borderRadius: radius.full,
      borderWidth: 1.5,
      borderColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    playGlyphOffset: { marginLeft: 2 },
    body: { flex: 1, justifyContent: 'center', gap: 4 },
    title: { color: colors.text, fontSize: typography.sizeMd, fontWeight: typography.weightSemibold },
    timeRow: { flexDirection: 'row', justifyContent: 'space-between' },
    timeText: { color: colors.textDim, fontSize: typography.sizeXs, fontVariant: ['tabular-nums'] },
    closeBtn: {
      width: 34,
      height: 34,
      alignItems: 'center',
      justifyContent: 'center',
    },
    speedChip: {
      minWidth: 38,
      height: 28,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    speedChipText: {
      color: colors.text,
      fontSize: typography.sizeSm,
      fontWeight: typography.weightSemibold,
      fontVariant: ['tabular-nums'],
    },
    // Dropdown — a full-screen backdrop catches outside taps; the menu is pinned
    // top-right, just under the bar, roughly beneath the speed chip.
    menuBackdrop: { flex: 1 },
    menu: {
      position: 'absolute',
      right: spacing.md,
      minWidth: 92,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
      paddingVertical: spacing.xs,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.18,
      shadowRadius: 8,
      elevation: 8,
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: 9,
    },
    menuItemPressed: { backgroundColor: colors.surface2 },
    menuItemText: { color: colors.text, fontSize: typography.sizeLg, fontVariant: ['tabular-nums'] },
    menuItemTextActive: { color: colors.accent, fontWeight: typography.weightSemibold },
  })
}
