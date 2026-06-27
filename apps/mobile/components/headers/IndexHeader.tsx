import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { AppHeader } from './AppHeader'
import { StatusIcon } from './StatusIcon'

type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'

const BUTTON_SIZE = 32

function connectionLabel(status: ConnectionStatus): string {
  return status === 'connected'
    ? 'Connected'
    : status === 'connecting'
      ? 'Connecting'
      : 'Disconnected'
}

export function IndexHeader({
  connStatus,
  onSettings,
  onAdd,
}: {
  connStatus: ConnectionStatus
  onSettings: () => void
  onAdd: () => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const statusLabel = connectionLabel(connStatus)

  const connColor =
    connStatus === 'connected' ? colors.success
    : connStatus === 'connecting' ? colors.warn
    : colors.danger
  const showConnectionPulse = connStatus === 'connecting'

  return (
    <AppHeader
      title={<Text style={styles.title}>aji-chat</Text>}
      right={
        <View style={styles.rightRow}>
          <StatusIcon
            color={connColor}
            pulse={showConnectionPulse}
            accessibilityLabel={`Connection ${statusLabel}`}
          />
          <Pressable
            style={styles.iconBtn}
            onPress={onSettings}
            hitSlop={8}
            accessibilityRole='button'
            accessibilityLabel='Open settings'
            accessibilityHint='Opens app settings'
          >
            <Feather name="settings" size={20} color={colors.textMuted} />
          </Pressable>
          <Pressable
            style={styles.addBtn}
            onPress={onAdd}
            hitSlop={8}
            accessibilityRole='button'
            accessibilityLabel='Start new chat'
            accessibilityHint='Creates a new chat session'
          >
            <Text style={styles.addBtnText}>+</Text>
          </Pressable>
        </View>
      }
    />
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    title: { color: colors.text, fontSize: typography.size2xl, fontWeight: typography.weightBold },
    rightRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    iconBtn: {
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 4,
      marginHorizontal: spacing.sm,
    },
    addBtn: {
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: radius.full,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 4,
    },
    addBtnText: { color: colors.textOnAccent, fontSize: typography.sizeLg, lineHeight: 20 },
  })
}
