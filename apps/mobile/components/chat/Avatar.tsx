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

//        VARIANT: 'agent'                           VARIANT: 'user'
// +-------------------------------+         +-------------------------------+
// | avatar                        |         | avatar + avatarUser           |
// | (width: 80, height: 80)       |         | (width: 80, height: 80)       |
// | (borderRadius: radius.md)     |         | (borderRadius: radius.md)     |
// | (bg: colors.toolDim)          |         | (bg: colors.accentDim)        |
// |                               |         |                               |
// |       alignItems: 'center'    |         |       alignItems: 'center'    |
// |     justifyContent: 'center'  |         |     justifyContent: 'center'  |
// |                               |         |                               |
// |        [avatarText]           |         |    [avatarText + textUser]    |
// |            Label              |         |            Label              |
// |       (color: colors.tool)    |         |       (color: colors.accent)  |
// |                               |         |                               |
// +-------------------------------+         +-------------------------------+

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    avatar: {
      width: 40,
      height: 40,
      borderRadius: radius.md,
      backgroundColor: colors.toolDim,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: colors.tool, fontSize: typography.sizeXl, fontWeight: typography.weightSemibold },
    avatarUser: { backgroundColor: colors.accentDim },
    avatarTextUser: { color: colors.accent },
  })
}
