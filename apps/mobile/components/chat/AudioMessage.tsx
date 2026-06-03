/**
 * Inline audio player for `file` items whose mime is `audio/*`.
 *
 * The bytes arrive inline as base64 (see the `file` protocol event). expo-audio
 * plays a file:// URI, so on first render we materialize the base64 into a
 * stable cache file (named by item id, written once) and hand its URI to the
 * player. The cache file re-materializes from the stored base64 after an app
 * restart, so history keeps playing without any server round-trip.
 */
import { useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import * as FileSystem from 'expo-file-system/legacy'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import { extensionForMime } from './fileHelpers'
import { ensureAudioMode } from '../../utils/audioSession'

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

type FileItem = Extract<Item, { kind: 'file' }>

export function AudioMessage({ item, tint }: { item: FileItem; tint: boolean }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [uri, setUri] = useState<string | null>(null)

  // Materialize the base64 payload to a cache file once.
  useEffect(() => {
    ensureAudioMode()
    let cancelled = false
    const path = `${FileSystem.cacheDirectory}aji-file-${item.id}.${extensionForMime(item.mime, item.name)}`
    ;(async () => {
      try {
        const info = await FileSystem.getInfoAsync(path)
        if (!info.exists) {
          await FileSystem.writeAsStringAsync(path, item.data, {
            encoding: FileSystem.EncodingType.Base64,
          })
        }
        if (!cancelled) setUri(path)
      } catch (err) {
        console.warn('[AudioMessage] failed to write cache file', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [item.id, item.mime, item.name, item.data])

  const source = useMemo(() => (uri ? { uri } : null), [uri])
  const player = useAudioPlayer(source)
  const status = useAudioPlayerStatus(player)

  const duration = status.duration || item.duration || 0
  const position = status.currentTime || 0
  const progress = duration > 0 ? Math.min(1, position / duration) : 0
  const finished = duration > 0 && position >= duration - 0.05

  const onToggle = () => {
    if (!uri) return
    if (status.playing) {
      player.pause()
    } else {
      if (finished) player.seekTo(0)
      player.play()
    }
  }

  const fg = tint ? '#fff' : colors.text
  const accent = tint ? '#fff' : colors.accent
  const track = tint ? 'rgba(255,255,255,0.3)' : colors.border
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
            name={status.playing ? 'pause' : 'play'}
            size={18}
            color={accent}
            style={status.playing ? undefined : styles.playGlyphOffset}
          />
        </Pressable>
        <View style={styles.meta}>
          <View style={[styles.trackBg, { backgroundColor: track }]}>
            <View style={[styles.trackFill, { backgroundColor: accent, width: `${progress * 100}%` }]} />
          </View>
          <Text style={[styles.time, { color: fg }]}>
            {formatTime(position)} / {formatTime(duration)}
          </Text>
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
    meta: { flex: 1, gap: spacing.xs },
    trackBg: { height: 4, borderRadius: radius.full, overflow: 'hidden' },
    trackFill: { height: 4, borderRadius: radius.full },
    time: { fontSize: typography.sizeSm, fontVariant: ['tabular-nums'] },
    caption: { marginTop: spacing.sm, fontSize: typography.sizeLg, lineHeight: typography.lineHeightNormal },
  })
}
