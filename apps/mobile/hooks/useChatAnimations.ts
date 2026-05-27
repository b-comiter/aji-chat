import { useEffect, useRef } from 'react'
import { Animated, Keyboard, Platform } from 'react-native'
import type { AgentStatus } from '@aji/protocol'

/**
 * Animates the bottom padding of the screen to track the keyboard height on iOS.
 * On Android the OS handles this via windowSoftInputMode; the value stays fixed.
 */
export function useKeyboardOffset(safeBottom: number): Animated.Value {
  const kbOffsetRef = useRef<Animated.Value | null>(null)
  if (!kbOffsetRef.current) kbOffsetRef.current = new Animated.Value(safeBottom)
  const kbOffset = kbOffsetRef.current

  useEffect(() => {
    if (Platform.OS !== 'ios') return
    const onShow = Keyboard.addListener('keyboardWillShow', (e) => {
      Animated.timing(kbOffset, {
        toValue: e.endCoordinates.height,
        duration: e.duration,
        useNativeDriver: false,
      }).start()
    })
    const onHide = Keyboard.addListener('keyboardWillHide', (e) => {
      Animated.timing(kbOffset, { toValue: safeBottom, duration: e.duration, useNativeDriver: false }).start()
    })
    return () => { onShow.remove(); onHide.remove() }
  }, [kbOffset, safeBottom])

  return kbOffset
}

/**
 * Returns a scale value that loops 1→1.3→1 while the agent is working/thinking,
 * and snaps back to 1 when idle.
 */
export function usePulseAnimation(agentStatus: AgentStatus): Animated.Value {
  const pulseScale = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (agentStatus === 'idle') {
      Animated.timing(pulseScale, { toValue: 1, duration: 0, useNativeDriver: true }).start()
      return
    }
    const pulse = () => {
      Animated.sequence([
        Animated.timing(pulseScale, { toValue: 1.3, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseScale, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]).start(({ finished }) => { if (finished) pulse() })
    }
    pulse()
  }, [agentStatus, pulseScale])

  return pulseScale
}
