/**
 * Plays a short "new message" chime when a message is received in the open chat.
 *
 * This is deliberately a SEPARATE expo-audio player from the global
 * AudioPlayerContext (voice messages) — it's a fire-and-forget UI sound effect,
 * so it must never surface the mini-player or disturb whatever voice clip is
 * playing.
 *
 * It does not touch the iOS audio session: leaving the default category means the
 * chime respects the mute switch (no ding when the phone is silenced), which is
 * the expected behavior for a notification sound. Once a voice message has played
 * the session is in playback mode and the chime will follow that; acceptable.
 */
import { useCallback, useRef } from 'react'
import { useAudioPlayer } from 'expo-audio'

// A reconnect can replay a batch of missed events through the subscriber path
// (see WebSocketContext get_missed_events). Collapse any burst into one chime.
const MIN_INTERVAL_MS = 1000

export function useMessageSound(): () => void {
  const player = useAudioPlayer(require('../assets/sounds/message.wav'))
  const lastPlayedRef = useRef(0)

  return useCallback(() => {
    const now = Date.now()
    if (now - lastPlayedRef.current < MIN_INTERVAL_MS) return
    lastPlayedRef.current = now
    try {
      player.seekTo(0)
      player.play()
    } catch { /* player not ready — ignore */ }
  }, [player])
}
