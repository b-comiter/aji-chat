import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useEffect, useMemo, useState } from 'react'
import type { RecordedClip } from '../../../hooks/useVoiceRecorder'
import type { ComposerMode } from './types'

export function useVoicePreview(clip: RecordedClip | null, mode: ComposerMode) {
  const previewSource = useMemo(
    () => (mode === 'voice-review' && clip?.uri ? { uri: clip.uri } : null),
    [mode, clip?.uri],
  )
  const player = useAudioPlayer(previewSource)
  const status = useAudioPlayerStatus(player)

  const [polledTime, setPolledTime] = useState(0)
  useEffect(() => {
    if (!status.playing) {
      setPolledTime(player.currentTime)
      return
    }
    const id = setInterval(() => setPolledTime(player.currentTime), 50)
    return () => clearInterval(id)
  }, [status.playing, player])

  const finished = status.duration > 0 && polledTime >= status.duration - 0.05
  const progress = status.duration > 0 ? polledTime / status.duration : 0

  const toggle = () => {
    if (!previewSource) return
    if (status.playing) {
      player.pause()
    } else {
      if (finished) player.seekTo(0)
      player.play()
    }
  }

  const pause = () => {
    try {
      player.pause()
    } catch {}
  }

  return { status, polledTime, progress, finished, toggle, pause }
}
