import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'

/**
 * Two-letter initials for an avatar. Two words → first letter of each; one word
 * → first two letters; empty → 'AI'. Shared by the chat list, message rows, and
 * the chat header so initials stay consistent everywhere.
 */
export function avatarInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'AI'
  const words = trimmed.split(/\s+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return trimmed.slice(0, 2).toUpperCase()
}

/**
 * Deterministic background color for an agent avatar derived from a seed (the
 * server/agent name). Different agents get stable, distinct hues so they're
 * distinguishable at a glance. We fix saturation/lightness so the chip is a
 * solid mid-tone that reads in both light and dark app themes with white text —
 * the color is independent of the surrounding surface.
 */
export function avatarSeedColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i)
    hash |= 0 // force 32-bit
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 55%, 45%)`
}

export function Avatar({
  label,
  variant,
  size = 40,
  seed,
}: {
  label: string
  variant: 'agent' | 'user'
  /** Square edge length in px. The avatar is fully round (borderRadius = size/2). */
  size?: number
  /**
   * Agent identity used to derive a stable per-agent color. When provided on an
   * agent avatar, overrides the default `toolDim` fill so different agents are
   * visually distinct. Ignored for the user variant.
   */
  seed?: string
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const seededBg = variant === 'agent' && seed ? avatarSeedColor(seed) : undefined

  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2 },
        variant === 'user' && styles.avatarUser,
        seededBg ? { backgroundColor: seededBg } : null,
      ]}
    >
      <Text
        style={[
          styles.avatarText,
          { fontSize: size * 0.42 },
          variant === 'user' && styles.avatarTextUser,
          seededBg ? styles.avatarTextSeeded : null,
        ]}
      >
        {label}
      </Text>
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    avatar: {
      backgroundColor: colors.toolDim,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: colors.tool, fontWeight: typography.weightSemibold },
    avatarUser: { backgroundColor: colors.accentDim },
    avatarTextUser: { color: colors.accent },
    // White reads on every seeded hsl(…, 55%, 45%) chip in both themes.
    avatarTextSeeded: { color: '#ffffff' },
  })
}
