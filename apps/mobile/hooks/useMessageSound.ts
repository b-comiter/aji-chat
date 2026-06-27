/**
 * Plays the phone's default notification sound when a message is received.
 *
 * Uses expo-notifications to schedule an immediate local notification with
 * sound: 'default' — the system picks the user's chosen notification tone.
 * The notification handler in utils/push.ts suppresses the visual banner for
 * these chime notifications so only the sound plays.
 *
 * Falls back silently if notification permissions are not granted.
 */
import { useCallback, useRef } from 'react'
import * as Notifications from 'expo-notifications'

// Collapse any burst (e.g. missed-events replay on reconnect) into one chime.
const MIN_INTERVAL_MS = 1000

export function useMessageSound(): () => void {
  const lastPlayedRef = useRef(0)

  return useCallback(() => {
    const now = Date.now()
    if (now - lastPlayedRef.current < MIN_INTERVAL_MS) return
    lastPlayedRef.current = now
    Notifications.scheduleNotificationAsync({
      content: { sound: 'default', data: { chime: true } },
      trigger: null,
    }).catch(() => {})
  }, [])
}
