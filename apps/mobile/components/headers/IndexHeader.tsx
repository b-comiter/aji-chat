import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { AppHeader } from './AppHeader'

export function IndexHeader({
  connStatus,
  onSettings,
  onAdd,
}: {
  connStatus: 'connected' | 'connecting' | 'disconnected'
  onSettings: () => void
  onAdd: () => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const connColor =
    connStatus === 'connected' ? colors.success
    : connStatus === 'connecting' ? colors.warn
    : colors.danger

  return (
    <AppHeader
      title={<Text style={styles.title}>aji-chat</Text>}
      right={
        <View style={styles.rightRow}>
          <View style={[styles.connDot, { backgroundColor: connColor }]} />
          <Pressable style={styles.iconBtn} onPress={onSettings} hitSlop={8}>
            <Feather name="settings" size={16} color={colors.textMuted} />
          </Pressable>
          <Pressable style={styles.addBtn} onPress={onAdd} hitSlop={8}>
            <Text style={styles.addBtnText}>＋</Text>
          </Pressable>
        </View>
      }
    />
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    title: { color: colors.text, fontSize: typography.size2xl, fontWeight: typography.weightBold },
    rightRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    connDot: { width: 8, height: 8, borderRadius: radius.full },
    iconBtn: { width: 30, height: 30, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
    addBtn: { width: 30, height: 30, borderRadius: radius.full, backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center' },
    addBtnText: { color: colors.text, fontSize: typography.sizeLg, lineHeight: 20 },
  })
}
