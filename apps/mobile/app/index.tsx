/**
 * Home screen — Telegram-style agent list.
 *
 * Shows one row per known agent, sorted by last activity. Loads from
 * SQLite on mount (instant), then patches in-memory state as live WS
 * events arrive. Tap a row to open that agent's chat history.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { useTheme } from '../context/ThemeContext'
import { getAllAgents, agentDisplayName, AGENT_DISPLAY_NAMES, type AgentRow } from '../db/database'
import type { ServerEvent } from '@aji/protocol'
import { spacing, typography, radius } from '../constants/theme'
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
  const mountedRef = useRef(true)

  // Load agent list from DB on mount
  useEffect(() => {
    getAllAgents(db).then((rows) => {
      if (mountedRef.current) setAgents(rows)
    })
    return () => { mountedRef.current = false }
  }, [db])

  // Subscribe to all WS events to patch in-memory agent rows in real-time
  useEffect(() => {
    return subscribe('*', (event: ServerEvent) => {
      const chatId = event.agent ?? 'unknown'

      setAgents((prev) => {
        switch (event.type) {
          case 'message_start':
          case 'tool_start':
          case 'permission_request':
          case 'clarify': {
            // Ensure agent row exists (may arrive before DB upsert completes)
            const exists = prev.some((a) => a.id === chatId)
            if (exists) return prev
            return [
              {
                id: chatId,
                display_name: agentDisplayName(chatId),
                last_message_preview: null,
                last_event_at: Date.now(),
                last_status: 'idle',
              },
              ...prev,
            ]
          }

          case 'message_end': {
            // Preview is updated by the context in DB; we update in-memory here
            // by re-reading from the inFlight text via the event's text accumulation.
            // Since we don't have the text here, just bump the timestamp.
            return prev.map((a) =>
              a.id === chatId ? { ...a, last_event_at: Date.now() } : a,
            )
          }

          case 'status': {
            const exists = prev.some((a) => a.id === chatId)
            if (!exists) {
              return [
                {
                  id: chatId,
                  display_name: agentDisplayName(chatId),
                  last_message_preview: null,
                  last_event_at: Date.now(),
                  last_status: event.value,
                },
                ...prev,
              ]
            }
            return prev.map((a) =>
              a.id === chatId ? { ...a, last_status: event.value } : a,
            )
          }

          default:
            return prev
        }
      })

      // After message_end, re-read agent row to get updated preview
      if (event.type === 'message_end') {
        getAllAgents(db).then((rows) => {
          if (mountedRef.current) setAgents(rows)
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
      <View style={[styles.statusDot, { backgroundColor: statusColor(agent.last_status, colors) }]} />
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
    statusDot: { width: 10, height: 10, borderRadius: radius.full, flexShrink: 0 },
    rowBody: { flex: 1 },
    rowTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
    agentName: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold, flex: 1 },
    timestamp: { color: colors.textDim, fontSize: typography.sizeSm },
    preview: { color: colors.textMuted, fontSize: typography.sizeMd },
    previewEmpty: { color: colors.textFaint, fontSize: typography.sizeMd, fontStyle: 'italic' },
    chevron: { color: colors.textFaint, fontSize: typography.size2xl },
  })
}
