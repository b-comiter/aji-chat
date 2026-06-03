/**
 * Composer bar — ChatGPT-style layout:
 *
 *   [+attach]  [   TextInput / voice surface   ]  [mic | send]
 *
 * Right button switches between mic and send:
 *   • mic  — shown when input is empty AND not focused
 *   • send — shown as soon as the user taps the input OR starts typing
 *
 * Tapping mic immediately starts recording (no intermediate "voice-idle").
 *
 * Voice modes:
 *   voice-recording  [✕ cancel]  [waveform + timer]  [■ stop]
 *   voice-review     [🗑 trash]   [waveform + ▶/⏸]    [↑ send]
 *
 * Attachment menu:
 *   Rendered above the composer row when [+] is tapped. Three slots —
 *   Camera / Photos / File — call optional handler props passed in from
 *   the parent screen. To hook them up install:
 *     expo-image-picker   (Camera + Photo Library)
 *     expo-document-picker (File)
 */
import { forwardRef, memo, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder'
import type { RecordedClip } from '../../hooks/useVoiceRecorder'
import { RecordingWaveform } from './RecordingWaveform'
import { downsampleBars, normalizeDb } from './waveformHelpers'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  draft: string
  setDraft: (text: string) => void
  onSend: () => void
  canSend: boolean
  blocked?: boolean
  /** Voice recording: fires when the user sends a clip. */
  onSendAudio?: (uri: string, durationMs: number) => void
  /**
   * Attachment handlers. Each is optional — omit to hide that option from
   * the menu. Wire up with expo-image-picker / expo-document-picker in the
   * parent screen.
   */
  onAttachCamera?: () => void
  onAttachPhoto?: () => void
  onAttachFile?: () => void
}

type Mode = 'text' | 'voice-recording' | 'voice-review'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── 3-bar custom waveform glyph ─────────────────────────────────────────────
// Three vertical bars at heights [45 %, 100 %, 45 %] — the universal "voice"
// symbol, matching what RecordingWaveform renders at the larger scale.

function VoiceModeIcon({ size, color }: { size: number; color: string }) {
  const barW = 3
  const barGap = 2
  const heights = [size * 0.45, size, size * 0.45]
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', width: size }}>
      {heights.map((h, i) => (
        <View
          key={i}
          style={{ width: barW, height: h, borderRadius: barW / 2, backgroundColor: color, marginLeft: i === 0 ? 0 : barGap }}
        />
      ))}
    </View>
  )
}

// ─── Stop glyph (red rounded square) ─────────────────────────────────────────

function StopGlyph() {
  return <View style={{ width: 17, height: 17, borderRadius: 3, backgroundColor: '#e23b3b' }} />
}

// ─── Attachment menu ──────────────────────────────────────────────────────────
// Rendered above the composer row (normal flow, not absolute-positioned).
// Only shows options whose handler props are provided.

interface AttachItem {
  icon: React.ComponentProps<typeof Feather>['name']
  label: string
  onPress: (() => void) | undefined
}

function AttachMenu({
  items,
  colors,
  styles,
}: {
  items: AttachItem[]
  colors: ThemeColors
  styles: ReturnType<typeof makeStyles>
}) {
  const visible = items.filter((it) => it.onPress !== undefined)
  if (visible.length === 0) return null
  return (
    <View style={styles.attachMenu}>
      {visible.map(({ icon, label, onPress }) => (
        <Pressable
          key={label}
          style={({ pressed }) => [styles.attachItem, pressed && styles.iconBtnPressed]}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={label}
        >
          <View style={[styles.attachIconCircle, { borderColor: colors.border }]}>
            <Feather name={icon} size={20} color={colors.text} />
          </View>
          <Text style={[styles.attachLabel, { color: colors.textDim }]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

// ─── useVoicePreview ──────────────────────────────────────────────────────────
// Encapsulates all preview-player state: source loading, polled playback time,
// derived progress/finished flags, and the play/pause toggle.

function useVoicePreview(clip: RecordedClip | null, mode: Mode) {
  const previewSource = useMemo(
    () => (mode === 'voice-review' && clip?.uri ? { uri: clip.uri } : null),
    [mode, clip?.uri],
  )
  const player = useAudioPlayer(previewSource)
  const status = useAudioPlayerStatus(player)

  // useAudioPlayerStatus is event-driven — currentTime doesn't update
  // continuously during playback. Poll the player directly instead.
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

  const pause = () => { try { player.pause() } catch {} }

  return { status, polledTime, progress, finished, toggle, pause }
}

// ─── Composer ─────────────────────────────────────────────────────────────────

export const Composer = memo(
  forwardRef<TextInput, Props>(function Composer(
    {
      draft, setDraft, onSend, canSend, blocked, onSendAudio,
      onAttachCamera, onAttachPhoto, onAttachFile,
    },
    ref,
  ) {
    const { colors } = useTheme()
    const styles = useMemo(() => makeStyles(colors), [colors])

    const isSlashDraft = draft.trimStart().startsWith('/')
    const softBlocked = !!blocked && !isSlashDraft

    const [mode, setMode] = useState<Mode>('text')
    const [inputFocused, setInputFocused] = useState(false)
    const [showAttachMenu, setShowAttachMenu] = useState(false)
    const [meteringTick, setMeteringTick] = useState(0)
    const capturedBarsRef = useRef<number[]>([])
    const [reviewBars, setReviewBars] = useState<number[]>([])

    const recorder = useVoiceRecorder()
    const { meteringDb, durationMs, clip } = recorder

    const preview = useVoicePreview(clip, mode)

    // Whether the right button shows send (↑) or mic
    const showSend = inputFocused || draft.trim().length > 0

    // ── Live waveform tick ───────────────────────────────────────────────
    useEffect(() => {
      if (mode !== 'voice-recording') return
      setMeteringTick((t) => t + 1)
      capturedBarsRef.current.push(normalizeDb(meteringDb))
    }, [meteringDb, mode])

    // ── Recording transitions ────────────────────────────────────────────

    const resetVoiceState = () => {
      capturedBarsRef.current = []
      setReviewBars([])
    }

    const startRecording = async () => {
      if (softBlocked) return
      setShowAttachMenu(false)
      resetVoiceState()
      const ok = await recorder.start()
      if (!ok) return   // permission denied — stays in text mode
      setMode('voice-recording')
    }

    const cancelRecording = async () => {
      await recorder.cancel()
      resetVoiceState()
      setMode('text')
    }

    const stopRecording = async () => {
      const next = await recorder.stop()
      setReviewBars(downsampleBars(capturedBarsRef.current))
      setMode(next ? 'voice-review' : 'text')
    }

    const discardRecording = async () => {
      preview.pause()
      await recorder.discard()
      resetVoiceState()
      setMode('text')
    }

    const sendRecording = () => {
      if (!clip || !onSendAudio) return
      preview.pause()
      onSendAudio(clip.uri, clip.durationMs)
      recorder.reset()
      resetVoiceState()
      setMode('text')
    }

    // ── Attachment menu items ─────────────────────────────────────────────
    const attachItems: AttachItem[] = [
      { icon: 'camera',    label: 'Camera', onPress: onAttachCamera  ? () => { setShowAttachMenu(false); onAttachCamera()  } : undefined },
      { icon: 'image',     label: 'Photos', onPress: onAttachPhoto   ? () => { setShowAttachMenu(false); onAttachPhoto()   } : undefined },
      { icon: 'paperclip', label: 'File',   onPress: onAttachFile    ? () => { setShowAttachMenu(false); onAttachFile()    } : undefined },
    ]
    const hasAnyAttachHandler = attachItems.some((it) => it.onPress !== undefined)

    // ── Render: voice modes ───────────────────────────────────────────────

    if (mode !== 'text') {
      return (
        <View style={styles.wrapper}>
          <View style={styles.composer}>

            {/* Left: cancel (recording) | trash (review) */}
            <Pressable
              style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
              onPress={mode === 'voice-recording' ? cancelRecording : discardRecording}
              accessibilityRole="button"
              accessibilityLabel={mode === 'voice-recording' ? 'Cancel recording' : 'Discard recording'}
              hitSlop={8}
            >
              {mode === 'voice-recording'
                ? <Feather name="x" size={20} color={colors.textDim} />
                : <Feather name="trash-2" size={20} color={colors.danger} />}
            </Pressable>

            {/* Center surface */}
            <View style={styles.voiceSurface}>
              {mode === 'voice-recording' && (
                <View style={styles.voiceRow}>
                  <Text style={[styles.duration, { color: colors.text }]}>
                    {formatDuration(durationMs)}
                  </Text>
                  <RecordingWaveform db={meteringDb} tick={meteringTick} />
                </View>
              )}
              {mode === 'voice-review' && (
                <View style={styles.voiceRow}>
                  <Pressable
                    onPress={preview.toggle}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={preview.status.playing ? 'Pause preview' : 'Play preview'}
                    style={({ pressed }) => [styles.previewPlayBtn, pressed && styles.iconBtnPressed]}
                  >
                    <Feather
                      name={preview.status.playing ? 'pause' : 'play'}
                      size={14}
                      color={colors.accent}
                      style={preview.status.playing ? undefined : { marginLeft: 1 }}
                    />
                  </Pressable>
                  <Text style={[styles.duration, styles.durationWide, { color: colors.text }]}>
                    {`${formatDuration(preview.status.playing ? preview.polledTime * 1000 : 0)} / ${formatDuration(clip?.durationMs ?? 0)}`}
                  </Text>
                  <RecordingWaveform staticBars={reviewBars} progress={preview.progress} />
                </View>
              )}
            </View>

            {/* Right: stop (recording) | send (review) */}
            {mode === 'voice-recording' && (
              <Pressable
                style={({ pressed }) => [styles.sendBtn, pressed && styles.iconBtnPressed]}
                onPress={stopRecording}
                accessibilityRole="button"
                accessibilityLabel="Stop recording"
                hitSlop={8}
              >
                <StopGlyph />
              </Pressable>
            )}
            {mode === 'voice-review' && (
              <Pressable
                style={({ pressed }) => [styles.sendBtn, pressed && styles.iconBtnPressed]}
                onPress={sendRecording}
                accessibilityRole="button"
                accessibilityLabel="Send voice message"
                hitSlop={8}
              >
                <Text style={styles.sendBtnText}>↑</Text>
              </Pressable>
            )}
          </View>
        </View>
      )
    }

    // ── Render: text mode ─────────────────────────────────────────────────

    return (
      <View style={styles.wrapper}>
        {/* Attachment menu — renders above composer row when open */}
        {showAttachMenu && (
          <AttachMenu items={attachItems} colors={colors} styles={styles} />
        )}

        <View style={[styles.composer, softBlocked && styles.composerBlocked]}>

          {/* Left: attachment / special functions */}
          <Pressable
            style={({ pressed }) => [
              styles.iconBtn,
              showAttachMenu && styles.iconBtnActive,
              pressed && styles.iconBtnPressed,
            ]}
            onPress={() => setShowAttachMenu((v) => !v)}
            disabled={softBlocked || !hasAnyAttachHandler}
            accessibilityRole="button"
            accessibilityLabel="Attachment options"
            hitSlop={8}
          >
            <Feather
              name={showAttachMenu ? 'x' : 'plus'}
              size={22}
              color={showAttachMenu ? colors.accent : colors.textDim}
            />
          </Pressable>

          {/* Center: text input */}
          <TextInput
            ref={ref}
            style={[styles.input, softBlocked && styles.inputBlocked]}
            value={draft}
            onChangeText={setDraft}
            onFocus={() => { setInputFocused(true); setShowAttachMenu(false) }}
            onBlur={() => setInputFocused(false)}
            placeholder={
              blocked && !isSlashDraft
                ? 'Answer the prompt above… or type / for commands'
                : 'Message…'
            }
            placeholderTextColor={colors.textDim}
            editable
            multiline
            submitBehavior="newline"
            autoCorrect={!isSlashDraft}
            spellCheck={!isSlashDraft}
            autoCapitalize={isSlashDraft ? 'none' : 'sentences'}
            returnKeyType="default"
          />

          {/* Right: send (when focused or has draft) | mic (otherwise) */}
          {showSend ? (
            <Pressable
              style={({ pressed }) => [
                styles.sendBtn,
                !canSend && styles.sendBtnOff,
                pressed && canSend && styles.iconBtnPressed,
              ]}
              onPress={onSend}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityState={{ disabled: !canSend }}
              hitSlop={8}
            >
              <Text style={styles.sendBtnText}>↑</Text>
            </Pressable>
          ) : (
            onSendAudio ? (
              <Pressable
                style={({ pressed }) => [styles.sendBtn, pressed && styles.iconBtnPressed]}
                onPress={startRecording}
                disabled={softBlocked}
                accessibilityRole="button"
                accessibilityLabel="Start voice recording"
                hitSlop={8}
              >
                <VoiceModeIcon size={18} color="#fff" />
              </Pressable>
            ) : null
          )}
        </View>
      </View>
    )
  }),
)

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrapper: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    composer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      gap: spacing.sm,
    },
    composerBlocked: { opacity: 0.55 },

    // Text input
    input: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 20,
      paddingHorizontal: spacing.lg,
      paddingVertical: 10,
      color: colors.text,
      fontSize: typography.sizeLg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    inputBlocked: { color: colors.textDim },

    // Buttons
    sendBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendBtnOff: { backgroundColor: colors.border },
    sendBtnText: {
      color: '#fff',
      fontSize: 18,
      fontWeight: typography.weightBold,
      lineHeight: 22,
    },
    iconBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconBtnActive: {
      backgroundColor: colors.surface2,
    },
    iconBtnPressed: { opacity: 0.55 },

    // Voice surface
    voiceSurface: {
      flex: 1,
      minHeight: 40,
      backgroundColor: colors.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.lg,
      paddingVertical: 8,
      justifyContent: 'center',
    },
    voiceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    duration: {
      fontSize: typography.sizeSm,
      fontVariant: ['tabular-nums'],
      minWidth: 36,
    },
    durationWide: { minWidth: 72 },

    // Review playback
    previewPlayBtn: {
      width: 26,
      height: 26,
      borderRadius: 13,
      borderWidth: 1.5,
      borderColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // Attachment menu
    attachMenu: {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      gap: spacing.xl,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
    },
    attachItem: {
      alignItems: 'center',
      gap: spacing.xs,
    },
    attachIconCircle: {
      width: 52,
      height: 52,
      borderRadius: 26,
      borderWidth: 1,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachLabel: {
      fontSize: typography.sizeSm,
    },
  })
}
