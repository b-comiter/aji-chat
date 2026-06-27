import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { Avatar } from './Avatar'

const DOT_SIZE = 7
const BOUNCE_HEIGHT = 5
const SPINNER_SIZE = 22
const SPINNER_BORDER = 2.5

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

// Round arc spinner — 3/4 of a circle (one gap) rotating at constant speed.
// Pure React Native: no SVG or third-party packages needed.
function SpinningLoader({ colors }: { colors: ThemeColors }) {
  const spinAnim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    )
    loop.start()
    return () => loop.stop()
  }, [spinAnim])

  const rotate = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  })

  const arc = colors.assistantBubbleText
  // Dim track shows the full circle beneath the arc
  const track = `${colors.assistantBubbleText}30`

  return (
    <View style={styles.spinner}>
      {/* Track — full circle at low opacity */}
      <View style={[styles.spinnerRing, { borderColor: track }]} />
      {/* Arc — 3/4 circle rotating */}
      <Animated.View
        style={[
          styles.spinnerRing,
          styles.spinnerArc,
          {
            borderTopColor: arc,
            borderRightColor: arc,
            borderBottomColor: arc,
            borderLeftColor: 'transparent',
            transform: [{ rotate }],
          },
        ]}
      />
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
          {agentStatus === 'working' ? (
            <SpinningLoader colors={colors} />
          ) : (
            <BouncingDots colors={colors} />
          )}
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
    // Fixed height — tall enough for the spinner (22px), which is larger than the dots (7px).
    minHeight: SPINNER_SIZE + spacing.md * 2,
    justifyContent: 'center',
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
  spinner: {
    width: SPINNER_SIZE,
    height: SPINNER_SIZE,
  },
  spinnerRing: {
    position: 'absolute',
    width: SPINNER_SIZE,
    height: SPINNER_SIZE,
    borderRadius: SPINNER_SIZE / 2,
    borderWidth: SPINNER_BORDER,
  },
  spinnerArc: {
    // Positioned on top of the track
  },
  time: {
    fontSize: typography.sizeXs,
    marginTop: 3,
  },
})
