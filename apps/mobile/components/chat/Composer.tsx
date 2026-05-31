import { forwardRef, memo, useMemo } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'

type Props = {
  draft: string
  setDraft: (text: string) => void
  onSend: () => void
  canSend: boolean
  blocked?: boolean
}

export const Composer = memo(
  forwardRef<TextInput, Props>(function Composer({ draft, setDraft, onSend, canSend, blocked }, ref) {
    const { colors } = useTheme()
    const styles = useMemo(() => makeStyles(colors), [colors])

    // Slash commands bypass the blocked state — they let the user run /approve,
    // /deny, or any local command even while a pending prompt is waiting.
    const isSlashDraft = draft.trimStart().startsWith('/')
    const softBlocked = !!blocked && !isSlashDraft

    return (
      <View style={[styles.composer, softBlocked && styles.composerBlocked]}>
        <TextInput
          ref={ref}
          style={[styles.input, softBlocked && styles.inputBlocked]}
          value={draft}
          onChangeText={setDraft}
          placeholder={blocked && !isSlashDraft ? 'Answer the prompt above… or type / for commands' : 'Message…'}
          placeholderTextColor={colors.textDim}
          editable
          multiline
          submitBehavior="newline"
          autoCorrect={!isSlashDraft}
          spellCheck={!isSlashDraft}
          autoCapitalize={isSlashDraft ? 'none' : 'sentences'}
          returnKeyType="default"
        />
        <Pressable
          style={[styles.sendBtn, !canSend && styles.sendBtnOff]}
          onPress={onSend}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityHint="Sends the current message or slash command"
          accessibilityState={{ disabled: !canSend }}
          hitSlop={8}
        >
          <Text style={styles.sendBtnText}>↑</Text>
        </Pressable>
      </View>
    )
  }),
)

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    composer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      gap: spacing.sm,
    },
    composerBlocked: { opacity: 0.55 },
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
    sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    sendBtnOff: { backgroundColor: colors.border },
    sendBtnText: { color: '#fff', fontSize: 18, fontWeight: typography.weightBold, lineHeight: 22 },
  })
}
