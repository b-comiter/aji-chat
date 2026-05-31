import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { AgentStatus } from '@aji/protocol'
import { useTheme } from '../../context/ThemeContext'
import { typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { AppHeader } from './AppHeader'
import { StatusIcon } from './StatusIcon'

export function ChatHeader({
  displayName,
  agentStatus,
  connStatus,
}: {
  displayName: string
  agentStatus: AgentStatus
  connStatus: 'connected' | 'connecting' | 'disconnected'
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const statusColor =
    agentStatus === 'idle' ? colors.success
    : agentStatus === 'thinking' ? colors.warn
    : colors.accent
  const agentStatusLabel =
    agentStatus === 'idle' ? 'Idle'
    : agentStatus === 'thinking' ? 'Thinking'
    : 'Working'

  return (
    <AppHeader
      left={
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
      }
      title={<Text style={styles.title} numberOfLines={1}>{displayName}</Text>}
      right={
        <View style={styles.statusContainer}>
          <StatusIcon
            color={statusColor}
            pulse={agentStatus !== 'idle'}
            accessibilityLabel={`Agent status ${agentStatusLabel}`}
          />
          {connStatus === 'disconnected' && (
            <View style={styles.connDotWrap}>
              <StatusIcon color={colors.danger} size={4} />
            </View>
          )}
        </View>
      }
    />
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backBtn: { paddingRight: 4 },
    backText: { color: colors.accent, fontSize: 28, lineHeight: 32 },
    title: { color: colors.text, fontSize: typography.sizeXl, fontWeight: typography.weightSemibold },
    statusContainer: { position: 'relative', width: 12, height: 12, alignItems: 'center', justifyContent: 'center' },
    connDotWrap: { position: 'absolute', bottom: 0, right: 0, borderRadius: radius.full },
  })
}
