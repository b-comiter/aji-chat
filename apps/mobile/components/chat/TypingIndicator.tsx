import { useEffect, useRef, useState } from 'react'
import { Animated, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { Avatar } from './Avatar'

const DOT_SIZE = 7
const BOUNCE_HEIGHT = 5

function formatElapsed(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

function BouncingDots({ colors }: { colors: ThemeColors }) {
  const dot1 = useRef(new Animated.Value(0)).current
  const dot2 = useRef(new Animated.Value(0)).current
  const dot3 = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const bounce = (dot: Animated.Value) =>
      Animated.sequence([
        Animated.timing(dot, { toValue: 1, duration: 280, useNativeDriver: true }),
        Animated.timing(dot, { toValue: 0, duration: 280, useNativeDriver: true }),
      ])

    const loop = Animated.loop(
      Animated.sequence([
        Animated.stagger(160, [bounce(dot1), bounce(dot2), bounce(dot3)]),
        Animated.delay(300),
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [dot1, dot2, dot3])

  return (
    <View style={styles.dots}>
      {([dot1, dot2, dot3] as const).map((dot, i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            {
              backgroundColor: colors.assistantBubbleText,
              transform: [
                { translateY: dot.interpolate({ inputRange: [0, 1], outputRange: [0, -BOUNCE_HEIGHT] }) },
              ],
              opacity: dot.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.3, 1, 0.3] }),
            },
          ]}
        />
      ))}
    </View>
  )
}

type Props = {
  agentStatus: 'thinking' | 'working'
  avatarLabel: string
  serverName?: string
}

export function TypingIndicator({ agentStatus, avatarLabel, serverName }: Props) {
  const { colors } = useTheme()
  const startRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  const fadeAnim = useRef(new Animated.Value(0)).current

  // Fade in on mount
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start()
  }, [fadeAnim])

  // Elapsed timer — starts when this component mounts, resets when unmounted
  useEffect(() => {
    startRef.current = Date.now()
    setElapsed(0)
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <Animated.View style={[styles.wrapper, { opacity: fadeAnim }]}>
      <View style={styles.meta}>
        <Avatar label={avatarLabel} variant="agent" seed={serverName} />
      </View>
      <View style={styles.alignLeft}>
        <View
          style={[
            styles.bubble,
            {
              backgroundColor: colors.assistantBubbleBg,
              borderColor: colors.assistantBubbleBorder,
            },
          ]}
        >
          <BouncingDots colors={colors} />
        </View>
        <Text style={[styles.time, { color: colors.textDim }]}>
          {agentStatus === 'thinking' ? 'thinking' : 'working'} · {formatElapsed(elapsed)}
        </Text>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'column',
    paddingVertical: spacing.sm,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  alignLeft: {
    alignItems: 'flex-start',
  },
  bubble: {
    borderRadius: 18,
    borderTopLeftRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
  },
  time: {
    fontSize: typography.sizeXs,
    marginTop: 3,
  },
})
