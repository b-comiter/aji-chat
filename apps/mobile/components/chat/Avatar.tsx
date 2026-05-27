import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'

export function Avatar({ label, variant }: { label: string; variant: 'agent' | 'user' }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={[styles.avatar, variant === 'user' && styles.avatarUser]}>
      <Text style={[styles.avatarText, variant === 'user' && styles.avatarTextUser]}>
        {label}
      </Text>
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    avatar: {
      width: 28,
      height: 28,
      borderRadius: radius.md,
      backgroundColor: colors.toolDim,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: colors.tool, fontSize: typography.sizeSm, fontWeight: typography.weightSemibold },
    avatarUser: { backgroundColor: colors.accentDim },
    avatarTextUser: { color: colors.accent },
  })
}
