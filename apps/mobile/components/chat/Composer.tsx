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
import { Feather } from '@expo/vector-icons'
import { forwardRef, memo, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Linking, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import type { ThemeColors } from '../../constants/theme'
import { spacing, typography } from '../../constants/theme'
import { useTheme } from '../../context/ThemeContext'
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder'
import { impactHaptic } from '../../utils/haptics'
import { AttachMenu } from './composer/AttachMenu'
import { MAX_INPUT_HEIGHT_FRACTION, MIN_INPUT_HEIGHT, formatDuration } from './composer/constants'
import { StopGlyph, VoiceModeIcon } from './composer/icons'
import type { AttachItem, ComposerMode, ComposerProps } from './composer/types'
import { useVoicePreview } from './composer/useVoicePreview'
import { RecordingWaveform } from './RecordingWaveform'
import { downsampleBars, normalizeDb } from './waveformHelpers'

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Composer ─────────────────────────────────────────────────────────────────

export const Composer = memo(
  forwardRef<TextInput, ComposerProps>(function Composer(
    {
      draft, setDraft, onSend, canSend, blocked, onSendAudio,
      onAttachCamera, onAttachPhoto, onAttachFile,
    },
    ref,
  ) {
    const { colors } = useTheme()
    const styles = useMemo(() => makeStyles(colors), [colors])

    // Cap auto-grow at a fraction of the screen so a long draft stays mostly
    // visible while typing, yet still leaves room for the conversation + keyboard.
    const { height: windowHeight } = useWindowDimensions()
    const maxInputHeight = Math.round(windowHeight * MAX_INPUT_HEIGHT_FRACTION)

    const isSlashDraft = draft.trimStart().startsWith('/')
    const softBlocked = !!blocked && !isSlashDraft

    const [mode, setMode] = useState<ComposerMode>('text')
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
      if (!ok) {
        if (recorder.permission === 'denied') {
          Alert.alert(
            'Microphone access required',
            'Allow microphone access in Settings to send voice messages.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ],
          )
        }
        return
      }
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
                onPress={() => { impactHaptic(); sendRecording() }}
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

          <TextInput
            ref={ref}
            style={[styles.input, softBlocked && styles.inputBlocked, { maxHeight: maxInputHeight }]}
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
              onPress={() => { impactHaptic(); onSend() }}
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
                onPress={() => {
                  console.log('[Composer] Audio record button pressed')
                  startRecording()
                }}
                disabled={softBlocked}
                accessibilityRole="button"
                accessibilityLabel="Start voice recording"
                hitSlop={8}
              >
                <VoiceModeIcon size={18} color={colors.textOnAccent} />
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
      alignItems: 'flex-end',
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      gap: spacing.sm,
    },
    composerBlocked: { opacity: 0.55 },

    // Text input. minHeight gives the one-line floor (matches the 40px side
    // buttons); maxHeight is applied inline (per-device). The TextInput grows
    // between them on its own as lines wrap.
    input: {
      flex: 1,
      minHeight: MIN_INPUT_HEIGHT,
      backgroundColor: colors.surface2,
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
      color: colors.textOnAccent,
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
      backgroundColor: colors.surface2,
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
