import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { AgentStatus } from '@aji/protocol'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { AppHeader } from './AppHeader'
import { StatusIcon } from './StatusIcon'
import { Avatar, avatarInitials } from '../chat/Avatar'

const HEADER_AVATAR_SIZE = 34

export function ChatHeader({
  displayName,
  channel,
  agentStatus,
  connStatus,
}: {
  displayName: string
  /** Channel within the server. Shown alongside the agent status when present. */
  channel?: string
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
      title={
        <View style={styles.titleRow}>
          <Avatar label={avatarInitials(displayName)} variant="agent" size={HEADER_AVATAR_SIZE} seed={displayName} />
          <View style={styles.titleCol}>
            <Text style={styles.title} numberOfLines={1}>{displayName}</Text>
            <View style={styles.statusRow}>
              <StatusIcon
                color={statusColor}
                size={7}
                pulse={agentStatus !== 'idle'}
                accessibilityLabel={`Agent status ${agentStatusLabel}`}
              />
              <Text style={[styles.statusText, { color: statusColor }]} numberOfLines={1}>
                {agentStatusLabel}
                {channel ? <Text style={styles.channel}>{`  ·  #${channel}`}</Text> : null}
              </Text>
            </View>
          </View>
        </View>
      }
      right={
        connStatus === 'disconnected' ? (
          <View style={styles.offline}>
            <StatusIcon color={colors.danger} size={6} />
            <Text style={styles.offlineText}>Offline</Text>
          </View>
        ) : undefined
      }
    />
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backBtn: { paddingRight: 4 },
    backText: { color: colors.accent, fontSize: 28, lineHeight: 32 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    titleCol: { flex: 1 },
    title: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold, lineHeight: 19 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
    statusText: { fontSize: typography.sizeSm, fontWeight: typography.weightMedium },
    channel: { color: colors.textDim, fontWeight: typography.weightRegular },
    offline: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    offlineText: { color: colors.danger, fontSize: typography.sizeXs, fontWeight: typography.weightMedium },
  })
}
