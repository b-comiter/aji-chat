import { Feather } from '@expo/vector-icons'
import { Pressable, Text, View } from 'react-native'
import type { StyleProp, TextStyle, ViewStyle } from 'react-native'
import type { ThemeColors } from '../../../constants/theme'
import type { AttachItem } from './types'

type AttachMenuStyles = {
  attachMenu: StyleProp<ViewStyle>
  attachItem: StyleProp<ViewStyle>
  iconBtnPressed: StyleProp<ViewStyle>
  attachIconCircle: StyleProp<ViewStyle>
  attachLabel: StyleProp<TextStyle>
}

export function AttachMenu({
  items,
  colors,
  styles,
}: {
  items: AttachItem[]
  colors: ThemeColors
  styles: AttachMenuStyles
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
