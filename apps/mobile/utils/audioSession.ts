/**
 * Shared audio session configuration. Both playback (AudioMessage) and
 * recording (useVoiceRecorder) need the iOS audio session configured so
 * playback works with the mute switch on. Idempotent guard avoids redundant
 * native calls per call site.
 */
import { setAudioModeAsync } from 'expo-audio'

let audioModeConfigured = false

export function ensureAudioMode(): void {
  if (audioModeConfigured) return
  audioModeConfigured = true
  setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true }).catch(() => {})
}
