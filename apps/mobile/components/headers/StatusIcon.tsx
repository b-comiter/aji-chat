import { useEffect, useMemo, useRef } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'

const DEFAULT_DOT_SIZE = 12
const DEFAULT_PULSE_DURATION_MS = 1600
const MAX_RING_SCALE = 2.2

export function StatusIcon({
  color,
  size = DEFAULT_DOT_SIZE,
  pulse = false,
  accessibilityLabel,
}: {
  color: string
  size?: number
  pulse?: boolean
  accessibilityLabel?: string
}) {
  const styles = useMemo(() => makeStyles(size), [size])
  const pulseValue = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!pulse) {
      pulseValue.stopAnimation()
      pulseValue.setValue(0)
      return
    }

    const animation = Animated.loop(
      Animated.timing(pulseValue, {
        toValue: 1,
        duration: DEFAULT_PULSE_DURATION_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    )
    animation.start()

    return () => animation.stop()
  }, [pulse, pulseValue])

  const ringStyle = useMemo(() => {
    const scale = pulseValue.interpolate({ inputRange: [0, 1], outputRange: [1, MAX_RING_SCALE] })
    const opacity = pulseValue.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] })
    return {
      borderColor: color,
      opacity,
      transform: [{ scale }],
    }
  }, [color, pulseValue])

  return (
    <View
      style={styles.container}
      accessible={Boolean(accessibilityLabel)}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
    >
      {pulse && <Animated.View pointerEvents='none' style={[styles.ring, ringStyle]} />}
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  )
}

function makeStyles(size: number) {
  return StyleSheet.create({
    container: {
      width: size,
      height: size,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dot: {
      width: size,
      height: size,
      borderRadius: size / 2,
    },
    ring: {
      position: 'absolute',
      width: size,
      height: size,
      borderRadius: size / 2,
      borderWidth: 2,
    },
  })
}