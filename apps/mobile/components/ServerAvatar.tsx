/**
 * Circular server avatar with a status ring.
 *
 * `avatar` encodes the source: `data:<base64>` (a picked image), `emoji:<glyph>`
 * (a preset), or null/undefined (fall back to initials of `label`). The ring
 * color carries the server's live status, so this can replace the standalone
 * status dot on the home screen without losing that signal.
 */
import { useMemo } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../context/ThemeContext'
import { radius, typography } from '../constants/theme'
import type { ThemeColors } from '../constants/theme'

export const AVATAR_PRESETS = ['🤖', '🧠', '⚡', '🛰️', '📡', '🦊', '🐙', '🌙', '🔧', '📨'] as const

function statusColor(status: string, colors: ThemeColors): string {
  switch (status) {
    case 'thinking':
    case 'working':
      return colors.warn
    case 'idle':
      return colors.success
    default:
      return colors.textDim
  }
}

function initials(label: string): string {
  const t = label.trim()
  if (!t) return '?'
  const words = t.split(/\s+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return t.slice(0, 2).toUpperCase()
}

export function ServerAvatar({
  avatar,
  status = 'idle',
  label,
  size = 44,
  showStatus = true,
}: {
  avatar?: string | null
  status?: string
  label: string
  size?: number
  showStatus?: boolean
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const ring = showStatus ? statusColor(status, colors) : colors.border
  const inner = size - 6

  const content = (() => {
    if (avatar?.startsWith('data:')) {
      return <Image source={{ uri: avatar }} style={{ width: inner, height: inner, borderRadius: inner / 2 }} />
    }
    if (avatar?.startsWith('emoji:')) {
      return <Text style={{ fontSize: inner * 0.55 }}>{avatar.slice('emoji:'.length)}</Text>
    }
    return <Text style={[styles.initials, { fontSize: inner * 0.36 }]}>{initials(label)}</Text>
  })()

  return (
    <View
      style={[
        styles.ring,
        { width: size, height: size, borderRadius: size / 2, borderColor: ring },
      ]}
    >
      <View style={[styles.inner, { width: inner, height: inner, borderRadius: inner / 2 }]}>
        {content}
      </View>
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    ring: {
      borderWidth: 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    inner: {
      backgroundColor: colors.surface2 ?? colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      borderRadius: radius.full,
    },
    initials: {
      color: colors.textMuted,
      fontWeight: typography.weightSemibold,
    },
  })
}
