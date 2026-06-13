/**
 * Shared audio session configuration. Playback and recording need different
 * iOS audio sessions and they actively conflict: a recording-capable session
 * (`allowsRecording: true`) suspends playback when the app is backgrounded, so
 * background playback only works with a playback-only session.
 *
 * The two modes toggle back and forth over a session's lifetime (record a clip,
 * then play one), so a one-shot boolean guard isn't enough — we track the last
 * applied mode and only re-issue the native call when it actually changes.
 */
import { setAudioModeAsync } from 'expo-audio'

type Mode = 'playback' | 'recording'

let currentMode: Mode | null = null

function apply(mode: Mode): void {
  if (currentMode === mode) return
  currentMode = mode
  if (mode === 'playback') {
    // shouldPlayInBackground keeps audio alive when the app is backgrounded /
    // the screen is locked (requires UIBackgroundModes:audio, set via the
    // expo-audio config plugin's enableBackgroundPlayback). allowsRecording must
    // be false here or iOS suspends playback in the background.
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      allowsRecording: false,
    }).catch(() => {
      currentMode = null // let a later call retry
    })
  } else {
    setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true }).catch(() => {
      currentMode = null
    })
  }
}

/** Configure the session for background-capable playback. */
export function ensurePlaybackMode(): void {
  apply('playback')
}

/** Configure the session for recording (mic capture). */
export function ensureRecordingMode(): void {
  apply('recording')
}
