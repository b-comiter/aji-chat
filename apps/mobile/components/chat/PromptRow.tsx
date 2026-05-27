import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'

type Props = {
  item: Extract<Item, { kind: 'prompt' }>
  onChoose: (id: string, choice: string) => void
}

export function PromptRow({ item, onChoose }: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [textValues, setTextValues] = useState<Record<string, string>>({})
  const buttonOpts = item.options.filter((o) => !o.allowText)
  const textOpts = item.options.filter((o) => o.allowText)

  return (
    <View style={styles.promptCard}>
      <Text style={styles.promptTitle}>{item.title}</Text>
      <Text style={styles.promptMsg}>{item.message}</Text>
      {buttonOpts.length > 0 && (
        <View style={styles.promptBtns}>
          {buttonOpts.map((opt, i) => (
            <Pressable
              key={opt.id}
              style={styles.promptBtn}
              onPress={() => onChoose(item.id, opt.id)}
            >
              <Text style={styles.promptBtnNum}>{i + 1}</Text>
              <Text style={styles.promptBtnText}>{opt.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {textOpts.map((opt) => (
        <View key={opt.id} style={styles.textOptWrap}>
          <Text style={styles.textOptLabel}>{opt.label}</Text>
          <View style={styles.textOptRow}>
            <TextInput
              style={styles.textOptInput}
              value={textValues[opt.id] ?? ''}
              onChangeText={(v) => setTextValues((prev) => ({ ...prev, [opt.id]: v }))}
              placeholder="Type your answer…"
              placeholderTextColor={colors.textDim}
              returnKeyType="send"
              onSubmitEditing={() => {
                const val = (textValues[opt.id] ?? '').trim()
                if (val) onChoose(item.id, val)
              }}
            />
            <Pressable
              style={[styles.textOptBtn, !(textValues[opt.id] ?? '').trim() && styles.textOptBtnOff]}
              disabled={!(textValues[opt.id] ?? '').trim()}
              onPress={() => {
                const val = (textValues[opt.id] ?? '').trim()
                if (val) onChoose(item.id, val)
              }}
            >
              <Text style={styles.textOptBtnText}>→</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    promptCard: {
      backgroundColor: colors.surface3,
      borderRadius: radius.xl,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.warn,
    },
    promptTitle: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold, marginBottom: 4 },
    promptMsg: { color: colors.textMuted, fontSize: typography.size, marginBottom: spacing.md },
    promptBtns: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
    promptBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.accent,
      paddingHorizontal: 14,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
    },
    promptBtnNum: { color: 'rgba(255,255,255,0.6)', fontSize: typography.sizeXs, fontWeight: typography.weightBold, minWidth: 14, textAlign: 'center' },
    promptBtnText: { color: '#fff', fontSize: typography.sizeMd, fontWeight: typography.weightSemibold },
    textOptWrap: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.borderAlt, paddingTop: 10 },
    textOptLabel: { color: colors.textMuted, fontSize: typography.sizeSm, fontWeight: typography.weightSemibold, marginBottom: 6 },
    textOptRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    textOptInput: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 10,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: colors.text,
      fontSize: typography.size,
      borderWidth: 1,
      borderColor: colors.borderAlt,
    },
    textOptBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    textOptBtnOff: { backgroundColor: colors.border },
    textOptBtnText: { color: '#fff', fontSize: 18, fontWeight: typography.weightBold },
  })
}
