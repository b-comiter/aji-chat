/**
 * Centered "Today / Yesterday / March 3" pill shown above the first message of
 * each calendar day in the chat timeline. Rendered by the chat screen's
 * renderItem above the relevant Row (not inside Row), so it stays decoupled from
 * the message rendering.
 */
import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'

export function DaySeparator({ label }: { label: string }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.row}>
      <View style={styles.pill}>
        <Text style={styles.text}>{label}</Text>
      </View>
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: { alignItems: 'center', paddingVertical: spacing.sm },
    pill: {
      backgroundColor: colors.surface2,
      borderRadius: radius.full,
      paddingHorizontal: spacing.md,
      paddingVertical: 3,
    },
    text: {
      color: colors.textDim,
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
    },
  })
}
