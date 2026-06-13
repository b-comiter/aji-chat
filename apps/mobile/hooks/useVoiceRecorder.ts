/**
 * Records audio for the composer's voice mode.
 *
 * Wraps expo-audio's `useAudioRecorder` / `useAudioRecorderState` with a tiny
 * state machine the composer can drive: `idle → recording → recorded`.
 *
 * Metering is enabled so the live waveform component can read amplitude (dB)
 * off `status.metering` on each poll. Recording produces an .m4a (audio/mp4)
 * file on iOS, which is what the protocol's `user_file` event carries.
 *
 * Errors and denied permissions never throw — they resolve back to `idle` and
 * surface a `permission` flag so the composer can show a brief notice instead
 * of crashing the chat screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AudioModule,
  RecordingPresets,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio'
import { File } from 'expo-file-system'
import { ensureRecordingMode } from '../utils/audioSession'

export type VoicePermissionState = 'unknown' | 'granted' | 'denied'

export type VoiceRecorderMode = 'idle' | 'recording' | 'recorded'

export interface RecordedClip {
  uri: string
  durationMs: number
}

const METERING_POLL_MS = 60

export function useVoiceRecorder() {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  })
  const status = useAudioRecorderState(recorder, METERING_POLL_MS)

  const [mode, setMode] = useState<VoiceRecorderMode>('idle')
  const [permission, setPermission] = useState<VoicePermissionState>('unknown')
  const [clip, setClip] = useState<RecordedClip | null>(null)
  const recordingStartedAtRef = useRef<number | null>(null)
  const isRecordingRef = useRef(false)

  useEffect(() => {
    isRecordingRef.current = status.isRecording
  }, [status.isRecording])

  const start = useCallback(async (): Promise<boolean> => {
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync()
      if (!perm.granted) {
        setPermission('denied')
        return false
      }
      setPermission('granted')
      ensureRecordingMode()
      await recorder.prepareToRecordAsync()
      recorder.record()
      recordingStartedAtRef.current = Date.now()
      setClip(null)
      setMode('recording')
      return true
    } catch (err) {
      console.warn('[useVoiceRecorder] start failed', err)
      setMode('idle')
      return false
    }
  }, [recorder])

  const stop = useCallback(async (): Promise<RecordedClip | null> => {
    try {
      await recorder.stop()
    } catch (err) {
      console.warn('[useVoiceRecorder] stop failed', err)
    }
    const uri = recorder.uri
    if (!uri) {
      setMode('idle')
      return null
    }
    // status.durationMillis is the most accurate read of the final length, but
    // fall back to wall-clock if the native side hasn't refreshed yet.
    const wallMs = recordingStartedAtRef.current ? Date.now() - recordingStartedAtRef.current : 0
    const durationMs = Math.max(status.durationMillis ?? 0, wallMs, 0)
    const next: RecordedClip = { uri, durationMs }
    setClip(next)
    setMode('recorded')
    return next
  }, [recorder, status.durationMillis])

  const discard = useCallback(async () => {
    if (clip?.uri) {
      try {
        new File(clip.uri).delete()
      } catch (err) {
        console.warn('[useVoiceRecorder] discard failed', err)
      }
    }
    setClip(null)
    setMode('idle')
  }, [clip])

  // cancel() is called when the user aborts mid-recording (before stop has run).
  // It stops the recorder, deletes whatever partial file was written, and resets.
  const cancel = useCallback(async () => {
    let uri: string | null = null
    try {
      await recorder.stop()
      uri = recorder.uri ?? null
    } catch {
      // already stopped or never started — ignore
    }
    if (uri) {
      try { new File(uri).delete() } catch {}
    }
    setClip(null)
    setMode('idle')
  }, [recorder])

  const reset = useCallback(() => {
    setClip(null)
    setMode('idle')
  }, [])

  // Safety net: if the component unmounts mid-record, stop the recorder so the
  // mic is released. Discarding the file is the caller's responsibility.
  useEffect(() => {
    return () => {
      if (isRecordingRef.current) {
        recorder.stop().catch(() => {})
      }
    }
  }, [recorder])

  return {
    mode,
    permission,
    cancel,
    clip,
    meteringDb: status.metering ?? null,
    durationMs: mode === 'recording' && recordingStartedAtRef.current
      ? Date.now() - recordingStartedAtRef.current
      : clip?.durationMs ?? 0,
    isRecording: status.isRecording,
    start,
    stop,
    discard,
    reset,
  }
}
