import { useMemo } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import type { CommandItem } from '@aji/protocol'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'

type Props = {
  items: CommandItem[]
  onSelect: (name: string) => void
}

export function CommandPicker({ items, onSelect }: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.pickerWrap}>
      <FlatList
        data={items}
        keyExtractor={(c) => c.name}
        keyboardShouldPersistTaps="always"
        style={styles.pickerList}
        renderItem={({ item: cmd }) => (
          <Pressable style={styles.pickerRow} onPress={() => onSelect(cmd.name)}>
            <View style={styles.pickerLeft}>
              <Text style={styles.pickerName}>/{cmd.name}</Text>
              {cmd.args_hint && <Text style={styles.pickerHint}> {cmd.args_hint}</Text>}
            </View>
            <Text style={styles.pickerDesc} numberOfLines={1}>{cmd.description}</Text>
          </Pressable>
        )}
      />
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    pickerWrap: { maxHeight: 260, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
    pickerList: { flexGrow: 0 },
    pickerRow: {
      paddingHorizontal: spacing.lg,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    pickerLeft: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 2 },
    pickerName: { color: colors.accent, fontSize: typography.size, fontWeight: typography.weightSemibold },
    pickerHint: { color: colors.textMuted, fontSize: typography.sizeSm, fontStyle: 'italic' },
    pickerDesc: { color: colors.textDim, fontSize: typography.sizeSm },
  })
}
