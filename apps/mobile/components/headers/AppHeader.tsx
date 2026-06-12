import { useMemo } from 'react'
import { View, StyleSheet } from 'react-native'
import type { ReactNode } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../../context/ThemeContext'
import { spacing } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'

export function AppHeader({
  left,
  title,
  right,
}: {
  left?: ReactNode
  title: ReactNode
  right?: ReactNode
}) {
  const { colors } = useTheme()
  const { top: safeTop } = useSafeAreaInsets()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={[styles.header, { paddingTop: safeTop + spacing.md }]}>
      {left}
      <View style={styles.title}>{title}</View>
      {right}
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
      backgroundColor: colors.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.sm,
    },
    title: { flex: 1 },
  })
}
