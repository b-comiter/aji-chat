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
}

export const Composer = memo(
  forwardRef<TextInput, Props>(function Composer({ draft, setDraft, onSend, canSend }, ref) {
    const { colors } = useTheme()
    const styles = useMemo(() => makeStyles(colors), [colors])
    return (
      <View style={styles.composer}>
        <TextInput
          ref={ref}
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message…"
          placeholderTextColor={colors.textDim}
          returnKeyType="send"
          onSubmitEditing={onSend}
        />
        <Pressable
          style={[styles.sendBtn, !canSend && styles.sendBtnOff]}
          onPress={onSend}
          disabled={!canSend}
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
    sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    sendBtnOff: { backgroundColor: colors.border },
    sendBtnText: { color: '#fff', fontSize: 18, fontWeight: typography.weightBold, lineHeight: 22 },
  })
}
