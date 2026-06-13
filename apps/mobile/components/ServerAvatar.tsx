/**
 * Circular server avatar.
 *
 * `avatar` encodes the source: `data:<base64>` (a picked image), `emoji:<glyph>`
 * (a preset), or null/undefined (fall back to initials of `label`). The initials
 * fallback is filled with a per-server seed color (hashed from `label`) so
 * different agents are visually distinct — matching the chat message `Avatar`.
 *
 * An optional presence dot sits at the bottom-right, color-coded to the agent's
 * live status (gold = working/thinking, green = idle, slate = never active). The
 * dot wears a ring in the row's background color so it reads as floating on top.
 */
import { useEffect, useMemo, useRef } from 'react'
import { Animated, Easing, Image, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../context/ThemeContext'
import { radius, typography } from '../constants/theme'
import type { ThemeColors } from '../constants/theme'
import { avatarInitials, avatarSeedColor } from './chat/Avatar'

export const AVATAR_PRESETS = ['🤖', '🧠', '⚡', '🛰️', '📡', '🦊', '🐙', '🌙', '🔧', '📨'] as const

const PULSE_DURATION_MS = 1600
const PULSE_MAX_SCALE = 2.6

export function ServerAvatar({
  avatar,
  label,
  size = 44,
  presenceColor = null,
  ringColor,
  pulse = false,
}: {
  avatar?: string | null
  label: string
  size?: number
  /** Status presence dot color (bottom-right); null hides the dot. */
  presenceColor?: string | null
  /** Ring drawn around the presence dot — should match the row background so the
   *  dot reads as lifted. Defaults to the screen background. */
  ringColor?: string
  /** Animate an expanding halo from the presence dot (use while the agent is
   *  actively working/thinking, so liveness reads as motion not just color). */
  pulse?: boolean
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const isImage = avatar?.startsWith('data:')
  const isEmoji = avatar?.startsWith('emoji:')

  // Seed color backs the initials fallback. Image covers its own background;
  // emoji keeps a neutral surface so the glyph reads.
  const bg = isImage ? 'transparent' : isEmoji ? colors.surface2 : avatarSeedColor(label)

  // Presence dot scales with the avatar so it stays proportional at any size.
  const dotSize = Math.round(size * 0.28)
  const ring = Math.max(2, Math.round(size * 0.055))

  // Expanding-halo loop for the active state. Mirrors StatusIcon's pulse so the
  // two liveness cues animate identically. Native-driver scale+opacity only.
  const pulseValue = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!pulse || !presenceColor) {
      pulseValue.stopAnimation()
      pulseValue.setValue(0)
      return
    }
    const animation = Animated.loop(
      Animated.timing(pulseValue, {
        toValue: 1,
        duration: PULSE_DURATION_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    )
    animation.start()
    return () => animation.stop()
  }, [pulse, presenceColor, pulseValue])

  const haloStyle = useMemo(
    () => ({
      transform: [{ scale: pulseValue.interpolate({ inputRange: [0, 1], outputRange: [1, PULSE_MAX_SCALE] }) }],
      opacity: pulseValue.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
    }),
    [pulseValue],
  )

  const content = isImage ? (
    <Image source={{ uri: avatar! }} style={{ width: size, height: size, borderRadius: size / 2 }} />
  ) : isEmoji ? (
    <Text style={{ fontSize: size * 0.5 }}>{avatar!.slice('emoji:'.length)}</Text>
  ) : (
    <Text style={[styles.initials, { fontSize: size * 0.38 }]}>{avatarInitials(label)}</Text>
  )

  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.circle,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
        ]}
      >
        {content}
      </View>
      {presenceColor ? (
        <View style={[styles.presenceWrap, { width: dotSize, height: dotSize }]} pointerEvents="none">
          {pulse ? (
            <Animated.View
              style={[
                styles.halo,
                { width: dotSize, height: dotSize, borderRadius: dotSize / 2, backgroundColor: presenceColor },
                haloStyle,
              ]}
            />
          ) : null}
          <View
            style={{
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              backgroundColor: presenceColor,
              borderWidth: ring,
              borderColor: ringColor ?? colors.bg,
            }}
          />
        </View>
      ) : null}
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    circle: {
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      borderRadius: radius.full,
    },
    initials: {
      color: '#ffffff',
      fontWeight: typography.weightSemibold,
    },
    presenceWrap: {
      position: 'absolute',
      bottom: -1,
      right: -1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    halo: {
      position: 'absolute',
    },
  })
}
