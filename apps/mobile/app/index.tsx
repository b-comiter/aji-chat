/**
 * Home screen — Telegram-style agent list.
 *
 * Shows one row per known agent, sorted by last activity. Loads from
 * SQLite on mount (instant), then patches in-memory state as live WS
 * events arrive. Tap a row to open that agent's chat history.
 */
import { useEffect, useRef, useState } from 'react'
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
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useWS } from '../context/WebSocketContext'
import { getAllAgents, agentDisplayName, AGENT_DISPLAY_NAMES, type AgentRow } from '../db/database'
import type { ServerEvent } from '@aji/protocol'

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

function statusColor(status: string): string {
  switch (status) {
    case 'thinking':
    case 'working':
      return '#d29922' // amber
    case 'idle':
      return '#3fb950' // green
    default:
      return '#6e7681' // grey
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HomeScreen() {
  const db = useDB()
  const { conn, subscribe } = useWS()
  const { top: safeTop } = useSafeAreaInsets()
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

  const connColor =
    conn === 'connected' ? '#3fb950' : conn === 'connecting' ? '#d29922' : '#f85149'

  return (
    <View style={[styles.screen, { paddingTop: safeTop }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>aji-chat</Text>
        <View style={[styles.connDot, { backgroundColor: connColor }]} />
        <Pressable style={styles.addBtn} onPress={() => setPickerOpen(true)} hitSlop={8}>
          <Text style={styles.addBtnText}>＋</Text>
        </Pressable>
      </View>

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
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={[styles.statusDot, { backgroundColor: statusColor(agent.last_status) }]} />
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0d1117' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
    gap: 8,
  },
  title: { color: '#e6edf3', fontSize: 20, fontWeight: '700', flex: 1 },
  connDot: { width: 8, height: 8, borderRadius: 4 },
  addBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#21262d', alignItems: 'center', justifyContent: 'center' },
  addBtnText: { color: '#e6edf3', fontSize: 16, lineHeight: 20 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  pickerCard: {
    width: 280,
    backgroundColor: '#161b22',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#21262d',
    overflow: 'hidden',
  },
  pickerTitle: { color: '#6e7681', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#21262d',
  },
  pickerLabel: { color: '#e6edf3', fontSize: 15, flex: 1 },
  pickerChevron: { color: '#3d444d', fontSize: 20 },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyTitle: { color: '#e6edf3', fontSize: 17, fontWeight: '600', marginBottom: 8 },
  emptySub: { color: '#6e7681', fontSize: 14, textAlign: 'center', lineHeight: 22 },
  code: { fontFamily: 'Menlo', color: '#b392f0' },
  list: { paddingTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#21262d',
    gap: 12,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
  agentName: { color: '#e6edf3', fontSize: 15, fontWeight: '600', flex: 1 },
  timestamp: { color: '#6e7681', fontSize: 12 },
  preview: { color: '#8b949e', fontSize: 13 },
  previewEmpty: { color: '#3d444d', fontSize: 13, fontStyle: 'italic' },
  chevron: { color: '#3d444d', fontSize: 20 },
})
