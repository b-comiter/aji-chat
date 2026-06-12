/**
 * Home screen — Telegram-style server list.
 *
 * Shows one row per known server, sorted by last activity. Loads from
 * SQLite on mount (instant), then patches in-memory state as live WS
 * events arrive. Tap a row to open the server (its channel list, or its single
 * chat if the server is mono-channel).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { useDB } from '../db/DBProvider'
import { useWS } from '../context/WebSocketContext'
import { IndexHeader } from '../components/headers/IndexHeader'
import { ServerAvatar } from '../components/ServerAvatar'
import { useTheme } from '../context/ThemeContext'
import {
  getAllServers,
  serverDisplayName,
  SERVER_DISPLAY_NAMES,
  isMonoChannel,
  DEFAULT_CHANNEL,
  type ServerRow,
} from '../db/database'
import type { ServerEvent } from '@aji/protocol'
import { spacing, typography } from '../constants/theme'
import type { ThemeColors } from '../constants/theme'

// Servers the user can manually open (excludes 'unknown')
const CONNECTABLE_SERVERS = Object.entries(SERVER_DISPLAY_NAMES)
  .filter(([id]) => id !== 'unknown')
  .map(([id, label]) => ({ id, label }))

/** Navigate into a server: mono-channel servers skip the channel list. */
function openServer(server: Pick<ServerRow, 'id' | 'mono_channel_advertised' | 'mono_channel_override'>) {
  if (isMonoChannel(server)) {
    router.push(`/chat/${server.id}/${DEFAULT_CHANNEL}`)
  } else {
    router.push(`/server/${server.id}`)
  }
}

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

function createPlaceholderServer(serverId: string, status: ServerRow['last_status'] = 'idle'): ServerRow {
  return {
    id: serverId,
    display_name: serverDisplayName(serverId),
    last_message_preview: null,
    last_event_at: Date.now(),
    last_status: status,
    avatar: null,
    mono_channel_advertised: null,
    mono_channel_override: null,
  }
}

function upsertMissingServer(prev: ServerRow[], serverId: string, status: ServerRow['last_status'] = 'idle'): ServerRow[] {
  if (prev.some((s) => s.id === serverId)) return prev
  return [createPlaceholderServer(serverId, status), ...prev]
}

function applyLiveServerEvent(prev: ServerRow[], event: ServerEvent): ServerRow[] {
  const serverId = ('serverId' in event ? event.serverId : undefined) ?? 'unknown'

  switch (event.type) {
    case 'message_start':
    case 'tool_start':
    case 'permission_request':
    case 'clarify':
    case 'file':
      return upsertMissingServer(prev, serverId)

    case 'message_end':
      return prev.map((s) =>
        s.id === serverId ? { ...s, last_event_at: Date.now() } : s,
      )

    case 'status': {
      const withPlaceholder = upsertMissingServer(prev, serverId, event.value)
      return withPlaceholder.map((s) =>
        s.id === serverId ? { ...s, last_status: event.value } : s,
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
  const [servers, setServers] = useState<ServerRow[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  // Reload the server list whenever the screen gains focus. Covers the initial
  // mount AND returning from the per-server settings page (avatar / name /
  // mono-channel edits write straight to SQLite with no WS event to patch in).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      getAllServers(db).then((rows) => {
        if (!cancelled) setServers(rows)
      })
      return () => {
        cancelled = true
      }
    }, [db]),
  )

  // Subscribe to all WS events to patch in-memory server rows in real-time
  useEffect(() => {
    return subscribe('*', (event: ServerEvent) => {
      setServers((prev) => applyLiveServerEvent(prev, event))

      // Re-read after events that change persisted columns we don't patch
      // in-memory (preview text, advertised name/mono-channel from server_info).
      // The subscribe() return unsubscribes on unmount, so the handler can't
      // fire post-unmount — no cancellation guard needed on the re-read.
      if (event.type === 'message_end' || event.type === 'file' || event.type === 'server_info') {
        getAllServers(db).then(setServers).catch((err) =>
          console.warn('[Home] server re-read failed', err),
        )
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
            <Text style={styles.pickerTitle}>Open server…</Text>
            {CONNECTABLE_SERVERS.map((server) => (
              <Pressable
                key={server.id}
                style={styles.pickerRow}
                onPress={() => {
                  setPickerOpen(false)
                  router.push(`/server/${server.id}`)
                }}
              >
                <Text style={styles.pickerLabel}>{server.label}</Text>
                <Text style={styles.pickerChevron}>›</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Server list */}
      {servers.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>No servers yet</Text>
          <Text style={styles.emptySub}>
            Waiting for an agent to connect…{'\n'}
            Run <Text style={styles.code}>pnpm simulate</Text> to test.
          </Text>
        </View>
      ) : (
        <FlatList
          data={servers}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => (
            <ServerListRow server={item} onPress={() => openServer(item)} />
          )}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// ServerListRow
// ---------------------------------------------------------------------------

function ServerListRow({ server, onPress }: { server: ServerRow; onPress: () => void }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <ServerAvatar
        avatar={server.avatar}
        status={server.last_status}
        label={server.display_name}
        size={44}
      />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.agentName}>{server.display_name}</Text>
          <Text style={styles.timestamp}>{relativeTime(server.last_event_at)}</Text>
        </View>
        {server.last_message_preview ? (
          <Text style={styles.preview} numberOfLines={1}>
            {server.last_message_preview}
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
