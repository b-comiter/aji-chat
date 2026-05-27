import { useMemo } from 'react'
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { AgentStatus } from '@aji/protocol'
import { useTheme } from '../../context/ThemeContext'
import { typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { AppHeader } from './AppHeader'

export function ChatHeader({
  displayName,
  agentStatus,
  pulseScale,
  connStatus,
}: {
  displayName: string
  agentStatus: AgentStatus
  pulseScale: Animated.Value
  connStatus: 'connected' | 'connecting' | 'disconnected'
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const statusColor =
    agentStatus === 'idle' ? colors.success
    : agentStatus === 'thinking' ? colors.warn
    : colors.accent

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
          <Animated.View
            style={[
              styles.statusDot,
              { backgroundColor: statusColor, transform: [{ scale: pulseScale }] },
            ]}
          />
          {connStatus === 'disconnected' && (
            <View style={[styles.connDot, { backgroundColor: colors.danger }]} />
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
    statusDot: { width: 8, height: 8, borderRadius: radius.full },
    connDot: { position: 'absolute', width: 4, height: 4, borderRadius: radius.full, bottom: 0, right: 0 },
  })
}
