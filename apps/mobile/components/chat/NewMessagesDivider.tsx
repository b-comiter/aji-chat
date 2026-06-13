/**
 * "New messages" line shown above the first message the user hadn't seen when
 * they opened the chat — marks where they left off. Rendered by the chat screen's
 * renderItem above the relevant Row, like DaySeparator.
 */
import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'

export function NewMessagesDivider() {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.row}>
      <View style={styles.line} />
      <Text style={styles.label}>New messages</Text>
      <View style={styles.line} />
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
    line: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.accent, opacity: 0.5 },
    label: {
      color: colors.accent,
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
    },
  })
}
