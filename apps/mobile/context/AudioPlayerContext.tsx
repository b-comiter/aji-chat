/**
 * Global audio playback — the single source of truth for "what's playing".
 *
 * Why a context (and not a per-bubble player)? A voice clip should keep playing
 * when the user leaves the chat, locks the screen, or backgrounds the app, and a
 * Telegram-style mini-player should follow them across screens. That requires
 * ONE player instance that outlives any screen, so it lives here — mounted once
 * above the navigation Stack (see app/_layout.tsx). Message bubbles
 * (AudioMessage) and the floating bar (MiniPlayer) are thin consumers that drive
 * this one player; none of them own playback state.
 *
 * The iOS session is put in background-capable playback mode on mount
 * (see utils/audioSession.ts).
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { ensurePlaybackMode } from '../utils/audioSession'

/** Selectable playback speeds, slowest → fastest. */
export const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const

/** Identity + display info for the currently-loaded track. */
export type AudioTrack = {
  /** Chat item id — pairs the global player with a specific message bubble. */
  itemId: string
  /** Source chat, so the mini-player can navigate back to it. */
  serverId: string
  channelId: string
  /** Label shown in the mini-player. */
  title: string
  /** Local file:// URI the player reads from. */
  uri: string
}

type AudioPlayerContextValue = {
  activeTrack: AudioTrack | null
  /** Live playback status for the active track. */
  playing: boolean
  currentTime: number
  duration: number
  /** Current playback speed (one of PLAYBACK_RATES); applies to all tracks. */
  rate: number
  setRate: (rate: number) => void
  /** Start (or resume) a track. Swaps the source if it's a different item. */
  play: (track: AudioTrack) => void
  /** Pause/resume the active track. */
  toggle: () => void
  pause: () => void
  seekTo: (seconds: number) => void
  /** Stop playback and dismiss the mini-player. */
  stop: () => void
}

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null)

export function useAudioPlayerContext(): AudioPlayerContextValue {
  const ctx = useContext(AudioPlayerContext)
  if (!ctx) throw new Error('useAudioPlayerContext must be used within <AudioPlayerProvider>')
  return ctx
}

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
  // One player for the whole app. Created empty; tracks are loaded via replace().
  const player = useAudioPlayer(null)
  const status = useAudioPlayerStatus(player)
  const [activeTrack, setActiveTrack] = useState<AudioTrack | null>(null)
  const [rate, setRateState] = useState(1)

  // Push a rate to the native player. Pitch-corrected so sped-up voices stay
  // natural rather than chipmunk-y. Guarded — the player may not be ready yet.
  const applyRate = useCallback((r: number) => {
    try {
      player.shouldCorrectPitch = true
      player.setPlaybackRate(r, 'high')
    } catch { /* player not ready — re-applied on next play() */ }
  }, [player])

  const setRate = useCallback((r: number) => {
    setRateState(r)
    applyRate(r)
  }, [applyRate])

  const play = useCallback((track: AudioTrack) => {
    ensurePlaybackMode()
    const isSame = activeTrack?.itemId === track.itemId
    if (!isSame) {
      player.replace({ uri: track.uri })
      setActiveTrack(track)
    } else if (status.duration > 0 && status.currentTime >= status.duration - 0.05) {
      // Resuming a finished clip — restart from the top.
      player.seekTo(0)
    }
    player.play()
    // Re-assert the rate — replace() resets the native player to 1×.
    applyRate(rate)
  }, [activeTrack, player, status.duration, status.currentTime, rate, applyRate])

  const toggle = useCallback(() => {
    if (status.playing) {
      player.pause()
    } else {
      if (status.duration > 0 && status.currentTime >= status.duration - 0.05) player.seekTo(0)
      player.play()
    }
  }, [player, status.playing, status.duration, status.currentTime])

  const pause = useCallback(() => {
    try { player.pause() } catch { /* player not ready — ignore */ }
  }, [player])

  const seekTo = useCallback((seconds: number) => {
    try { player.seekTo(seconds) } catch { /* ignore */ }
  }, [player])

  const stop = useCallback(() => {
    try { player.pause() } catch { /* ignore */ }
    setActiveTrack(null)
  }, [player])

  const value = useMemo<AudioPlayerContextValue>(() => ({
    activeTrack,
    playing: status.playing,
    currentTime: status.currentTime,
    duration: status.duration,
    rate,
    setRate,
    play,
    toggle,
    pause,
    seekTo,
    stop,
  }), [activeTrack, status.playing, status.currentTime, status.duration, rate, setRate, play, toggle, pause, seekTo, stop])

  return <AudioPlayerContext.Provider value={value}>{children}</AudioPlayerContext.Provider>
}
