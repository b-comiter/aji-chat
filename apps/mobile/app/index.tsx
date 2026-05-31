/**
 * Home screen — Telegram-style agent list.
 *
 * Shows one row per known agent, sorted by last activity. Loads from
 * SQLite on mount (instant), then patches in-memory state as live WS
 * events arrive. Tap a row to open that agent's chat history.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { router } from 'expo-router'
import { useDB } from '../db/DBProvider'
import { useWS } from '../context/WebSocketContext'
import { IndexHeader } from '../components/headers/IndexHeader'
import { StatusIcon } from '../components/headers/StatusIcon'
import { useTheme } from '../context/ThemeContext'
import { getAllAgents, agentDisplayName, AGENT_DISPLAY_NAMES, type AgentRow } from '../db/database'
import type { ServerEvent } from '@aji/protocol'
import { spacing, typography } from '../constants/theme'
import type { ThemeColors } from '../constants/theme'

// Agents the user can manually open a chat with (excludes 'unknown')
const CONNECTABLE_AGENTS = Object.entries(AGENT_DISPLAY_NAMES)
  .filter(([id]) => id !== 'unknown')
  .map(([id, label]) => ({ id, label }))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(ts: number | null): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  return `${days}d ago`
}

function statusColor(status: string, colors: ThemeColors): string {
  switch (status) {
    case 'thinking':
    case 'working':
      return colors.warn
    case 'idle':
      return colors.success
    default:
      return colors.textDim
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'thinking':
      return 'Thinking'
    case 'working':
      return 'Working'
    case 'idle':
      return 'Idle'
    default:
      return 'Unknown'
  }
}

function createPlaceholderAgent(chatId: string, status: AgentRow['last_status'] = 'idle'): AgentRow {
  return {
    id: chatId,
    display_name: agentDisplayName(chatId),
    last_message_preview: null,
    last_event_at: Date.now(),
    last_status: status,
  }
}

function upsertMissingAgent(prev: AgentRow[], chatId: string, status: AgentRow['last_status'] = 'idle'): AgentRow[] {
  if (prev.some((agent) => agent.id === chatId)) return prev
  return [createPlaceholderAgent(chatId, status), ...prev]
}

function applyLiveAgentEvent(prev: AgentRow[], event: ServerEvent): AgentRow[] {
  const chatId = event.agent ?? 'unknown'

  switch (event.type) {
    case 'message_start':
    case 'tool_start':
    case 'permission_request':
    case 'clarify':
    case 'file':
      return upsertMissingAgent(prev, chatId)

    case 'message_end':
      return prev.map((agent) =>
        agent.id === chatId ? { ...agent, last_event_at: Date.now() } : agent,
      )

    case 'status': {
      const withPlaceholder = upsertMissingAgent(prev, chatId, event.value)
      return withPlaceholder.map((agent) =>
        agent.id === chatId ? { ...agent, last_status: event.value } : agent,
      )
    }

    default:
      return prev
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HomeScreen() {
  const db = useDB()
  const { conn, subscribe } = useWS()
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  // Load agent list from DB on mount
  useEffect(() => {
    let cancelled = false

    getAllAgents(db).then((rows) => {
      if (!cancelled) setAgents(rows)
    })

    return () => {
      cancelled = true
    }
  }, [db])

  // Subscribe to all WS events to patch in-memory agent rows in real-time
  useEffect(() => {
    let cancelled = false

    return subscribe('*', (event: ServerEvent) => {
      setAgents((prev) => applyLiveAgentEvent(prev, event))

      // After message_end or file, re-read agent rows to get updated preview
      if (event.type === 'message_end' || event.type === 'file') {
        getAllAgents(db).then((rows) => {
          if (!cancelled) setAgents(rows)
        })
      }
    })
  }, [subscribe, db])

  return (
    <View style={styles.screen}>
      <IndexHeader
        connStatus={conn}
        onSettings={() => router.push('/settings')}
        onAdd={() => setPickerOpen(true)}
      />

      {/* Agent picker modal */}
      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPickerOpen(false)}>
          <View style={styles.pickerCard}>
            <Text style={styles.pickerTitle}>Open chat with…</Text>
            {CONNECTABLE_AGENTS.map((agent) => (
              <Pressable
                key={agent.id}
                style={styles.pickerRow}
                onPress={() => {
                  setPickerOpen(false)
                  router.push(`/chat/${agent.id}`)
                }}
              >
                <Text style={styles.pickerLabel}>{agent.label}</Text>
                <Text style={styles.pickerChevron}>›</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Agent list */}
      {agents.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>No agents yet</Text>
          <Text style={styles.emptySub}>
            Waiting for an agent to connect…{'\n'}
            Run <Text style={styles.code}>pnpm simulate</Text> to test.
          </Text>
        </View>
      ) : (
        <FlatList
          data={agents}
          keyExtractor={(a) => a.id}
          renderItem={({ item }) => (
            <AgentRow agent={item} onPress={() => router.push(`/chat/${item.id}`)} />
          )}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// AgentRow
// ---------------------------------------------------------------------------

function AgentRow({ agent, onPress }: { agent: AgentRow; onPress: () => void }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <StatusIcon
        color={statusColor(agent.last_status, colors)}
        size={10}
        pulse={agent.last_status !== 'idle'}
        accessibilityLabel={`Agent status ${statusLabel(agent.last_status)}`}
      />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.agentName}>{agent.display_name}</Text>
          <Text style={styles.timestamp}>{relativeTime(agent.last_event_at)}</Text>
        </View>
        {agent.last_message_preview ? (
          <Text style={styles.preview} numberOfLines={1}>
            {agent.last_message_preview}
          </Text>
        ) : (
          <Text style={styles.previewEmpty}>No messages yet</Text>
        )}
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
    pickerCard: {
      width: 280,
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    pickerTitle: {
      color: colors.textDim,
      fontSize: typography.sizeSm,
      fontWeight: typography.weightSemibold,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      paddingHorizontal: spacing.lg,
      paddingTop: 14,
      paddingBottom: 10,
    },
    pickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    pickerLabel: { color: colors.text, fontSize: typography.sizeLg, flex: 1 },
    pickerChevron: { color: colors.textFaint, fontSize: typography.size2xl },
    emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xxxl },
    emptyTitle: { color: colors.text, fontSize: typography.sizeXl, fontWeight: typography.weightSemibold, marginBottom: spacing.sm },
    emptySub: { color: colors.textDim, fontSize: typography.size, textAlign: 'center', lineHeight: typography.lineHeightNormal },
    code: { fontFamily: typography.fontMono, color: colors.tool },
    list: { paddingTop: spacing.sm },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.xl,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    rowBody: { flex: 1 },
    rowTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
    agentName: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold, flex: 1 },
    timestamp: { color: colors.textDim, fontSize: typography.sizeSm },
    preview: { color: colors.textMuted, fontSize: typography.sizeMd },
    previewEmpty: { color: colors.textFaint, fontSize: typography.sizeMd, fontStyle: 'italic' },
    chevron: { color: colors.textFaint, fontSize: typography.size2xl },
  })
}
