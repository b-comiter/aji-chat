/**
 * Shows one row per known server, sorted by last activity. Loads from
 * SQLite on mount (instant), then patches in-memory state as live WS
 * events arrive. Tap a row to open the server (its channel list, or its single
 * chat if the server is mono-channel).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons'
import { useDB } from '../db/DBProvider'
import { useWS } from '../context/WebSocketContext'
import { IndexHeader } from '../components/headers/IndexHeader'
import { ServerAvatar } from '../components/ServerAvatar'
import { SwipeableRow, type SwipeAction, type OpenSide } from '../components/SwipeableRow'
import { useTheme } from '../context/ThemeContext'
import {
  getAllServers,
  serverDisplayName,
  SERVER_DISPLAY_NAMES,
  isMonoChannel,
  isServerMuted,
  setServerMuted,
  isServerPinned,
  setServerPinned,
  getUnreadCounts,
  deleteServer,
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

// Swipe-action slab tints. These are conventional action colors (red = delete,
// green = pin) shown on their own colored slabs, so they're deliberately fixed
// rather than theme-derived — a delete reads red in both light and dark.
const ACTION_TINTS = {
  mute:     '#C9881E',
  settings: '#4E5E7A',
  delete:   '#C0453E',
  pin:      '#2E9E6E',
} as const

/** Client-side mirror of getAllServers' ORDER BY: pinned first, then recency. */
function sortServers(rows: ServerRow[]): ServerRow[] {
  return [...rows].sort((a, b) => {
    if (a.pin_position != null && b.pin_position != null) return a.pin_position - b.pin_position
    if (a.pin_position != null) return -1
    if (b.pin_position != null) return 1
    return (b.last_event_at ?? 0) - (a.last_event_at ?? 0)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(ts: number | null): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return '1d'
  return `${days}d`
}

/** Is the agent mid-turn (drives the live status line + gold presence dot)? */
function isActiveStatus(status: string): boolean {
  return status === 'thinking' || status === 'working'
}

/** Presence-dot color for a server's avatar: gold while active, green when idle
 *  with history, slate when it has never produced an event. */
function presenceColor(server: ServerRow, colors: ThemeColors): string {
  if (isActiveStatus(server.last_status)) return colors.warn
  if (server.last_event_at == null) return colors.textFaint
  return colors.success
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
    muted: 0,
    pin_position: null,
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
      // An arriving agent message clears the live "working/thinking" indicator
      // (Telegram-style), mirroring the DB write in WebSocketContext so the row
      // updates instantly without waiting for a focus re-read.
      return prev.map((s) =>
        s.id === serverId ? { ...s, last_event_at: Date.now(), last_status: 'idle' } : s,
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
  const { conn, subscribe, sendEvent } = useWS()
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [servers, setServers] = useState<ServerRow[]>([])
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({})
  const [pickerOpen, setPickerOpen] = useState(false)
  // Which row + side has its swipe drawer open (one at a time).
  const [open, setOpen] = useState<{ id: string; side: 'leading' | 'trailing' } | null>(null)

  // Open a server. Unread is now per-channel: opening the chat marks that channel
  // read (see the chat screen), and the home list re-reads counts on focus — so a
  // multi-channel server's badge correctly persists until its channels are read.
  const handleOpenServer = useCallback((server: ServerRow) => {
    openServer(server)
  }, [])

  const toggleMute = useCallback((server: ServerRow) => {
    const next = !isServerMuted(server)
    setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, muted: next ? 1 : 0 } : s)))
    setServerMuted(db, server.id, next).catch(console.warn)
    // Mirror to the server so it also suppresses push notifications for it.
    sendEvent({ type: 'set_mute', serverId: server.id, muted: next })
  }, [db, sendEvent])

  const togglePin = useCallback((server: ServerRow) => {
    const next = !isServerPinned(server)
    setServers((prev) =>
      sortServers(prev.map((s) => (s.id === server.id ? { ...s, pin_position: next ? -Date.now() : null } : s))),
    )
    setServerPinned(db, server.id, next).catch(console.warn)
  }, [db])

  const confirmDeleteServer = useCallback((server: ServerRow) => {
    Alert.alert(
      `Delete ${server.display_name}?`,
      'This removes the server and all its channels and message history on this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setServers((prev) => prev.filter((s) => s.id !== server.id))
            deleteServer(db, server.id).catch(console.warn)
          },
        },
      ],
    )
  }, [db])

  const actionsFor = useCallback((server: ServerRow): SwipeAction[] => {
    const muted = isServerMuted(server)
    return [
      {
        key: 'mute',
        icon: <Feather name={muted ? 'bell' : 'bell-off'} size={20} color="#fff" />,
        label: muted ? 'Unmute' : 'Mute',
        color: ACTION_TINTS.mute,
        onPress: () => toggleMute(server),
      },
      {
        key: 'settings',
        icon: <Feather name="settings" size={20} color="#fff" />,
        label: 'Settings',
        color: ACTION_TINTS.settings,
        onPress: () => router.push(`/server/${server.id}/settings`),
      },
      {
        key: 'delete',
        icon: <Feather name="trash-2" size={20} color="#fff" />,
        label: 'Delete',
        color: ACTION_TINTS.delete,
        onPress: () => confirmDeleteServer(server),
      },
    ]
  }, [toggleMute, confirmDeleteServer])

  // Right-swipe pin/unpin. A pushpin glyph (more distinctive than the Feather
  // set) makes the action read at a glance.
  const leadingPinAction = useCallback((server: ServerRow): SwipeAction => {
    const pinned = isServerPinned(server)
    return {
      key: 'pin',
      icon: <MaterialCommunityIcons name={pinned ? 'pin-off' : 'pin'} size={20} color="#fff" />,
      label: pinned ? 'Unpin' : 'Pin',
      color: ACTION_TINTS.pin,
      onPress: () => togglePin(server),
    }
  }, [togglePin])

  // Reload the server list whenever the screen gains focus. Covers the initial
  // mount AND returning from the per-server settings page (avatar / name /
  // mono-channel edits write straight to SQLite with no WS event to patch in).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      getAllServers(db).then((rows) => {
        if (!cancelled) setServers(rows)
      })
      getUnreadCounts(db).then((counts) => {
        if (!cancelled) setUnreadCounts(counts)
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
      // in-memory (preview text, advertised name/mono-channel from server_info)
      // and refresh unread counts as messages land. `status` is included because
      // a server's presence dot is the DB-derived aggregate of its channels'
      // statuses (see getAllServers) — the naive in-memory patch above can't see
      // sibling channels, so re-reading is what keeps the dot truthful.
      // The subscribe() return unsubscribes on unmount, so the handler can't
      // fire post-unmount — no cancellation guard needed on the re-read.
      if (
        event.type === 'message_end' ||
        event.type === 'file' ||
        event.type === 'server_info' ||
        event.type === 'status'
      ) {
        getAllServers(db).then(setServers).catch((err) =>
          console.warn('[Home] server re-read failed', err),
        )
        getUnreadCounts(db).then(setUnreadCounts).catch((err) =>
          console.warn('[Home] unread re-read failed', err),
        )
      }
    })
  }, [subscribe, db])

  // Socket not connected → presence in the list is last-known, not live.
  const stale = conn !== 'connected'

  return (
    <View style={styles.screen}>
      <IndexHeader
        connStatus={conn}
        onSettings={() => router.push('/settings')}
        onAdd={() => setPickerOpen(true)}
      />

      {stale && (
        <View style={styles.banner}>
          <Feather
            name="wifi-off"
            size={15}
            color={conn === 'connecting' ? colors.warn : colors.danger}
          />
          <Text style={[styles.bannerText, { color: conn === 'connecting' ? colors.warn : colors.danger }]}>
            {conn === 'connecting' ? 'Reconnecting…' : 'Offline'}
          </Text>
          <Text style={styles.bannerHint}>status may be stale</Text>
        </View>
      )}

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
            <SwipeableRow
              actions={actionsFor(item)}
              leadingAction={leadingPinAction(item)}
              openSide={open?.id === item.id ? open.side : null}
              onOpenSide={(side: OpenSide) => setOpen(side ? { id: item.id, side } : null)}
              onPress={() => handleOpenServer(item)}
            >
              <ServerListRow server={item} unreadCount={unreadCounts[item.id] ?? 0} stale={stale} />
            </SwipeableRow>
          )}
          contentContainerStyle={styles.list}
          onScrollBeginDrag={() => setOpen(null)}
        />
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// ServerListRow
// ---------------------------------------------------------------------------

// Presentational only — tap/scroll handling lives in the enclosing SwipeableRow.
// `stale` is set when the socket is down: presence is last-known, not live, so
// the dot goes slate (no pulse) and the row dims rather than implying liveness.
function ServerListRow({ server, unreadCount, stale }: { server: ServerRow; unreadCount: number; stale: boolean }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const unread = unreadCount > 0
  const pinned = isServerPinned(server)
  const muted = isServerMuted(server)
  const active = isActiveStatus(server.last_status)
  // Idle server that's never spoken — dim its name so live agents stand out.
  const quiet = !active && !server.last_message_preview && server.last_event_at == null
  const time = relativeTime(server.last_event_at)

  return (
    <View style={[styles.row, pinned && styles.rowPinned, stale && styles.rowStale]}>
      <ServerAvatar
        avatar={server.avatar}
        label={server.display_name}
        size={46}
        presenceColor={stale ? colors.textFaint : presenceColor(server, colors)}
        pulse={active && !stale}
        ringColor={pinned ? colors.surface : colors.bg}
      />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text
            style={[styles.agentName, unread && styles.agentNameUnread, quiet && styles.agentNameQuiet]}
            numberOfLines={1}
          >
            {server.display_name}
          </Text>
          {muted && (
            <Feather name="bell-off" size={13} color={colors.textDim} style={styles.mutedGlyph} />
          )}
          {pinned && (
            <MaterialCommunityIcons name="pin" size={13} color={colors.accent} style={styles.pinGlyph} />
          )}
        </View>
        {active && !stale ? (
          <View style={styles.statusRow}>
            <View style={styles.statusDot} />
            <Text style={styles.statusText} numberOfLines={1}>
              {server.last_status === 'thinking' ? 'thinking…' : 'working…'}
            </Text>
          </View>
        ) : server.last_message_preview ? (
          <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
            {server.last_message_preview}
          </Text>
        ) : (
          <Text style={styles.previewEmpty}>No messages yet</Text>
        )}
      </View>

      {/* Trailing column: unread count over last-activity time, center-aligned.
          A muted server's badge is gray (not gold) — it still counts, quietly. */}
      <View style={styles.trailing}>
        {unread && (
          <View style={[styles.unreadPill, muted && styles.unreadPillMuted]}>
            <Text style={[styles.unreadPillText, muted && styles.unreadPillTextMuted]} numberOfLines={1}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </Text>
          </View>
        )}
        {time ? <Text style={styles.timestamp}>{time}</Text> : null}
      </View>
    </View>
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
    // Pinned: subtle surface tint + a gold left-edge. The left border eats 3px,
    // so trim paddingLeft to keep the avatar aligned with unpinned rows.
    rowPinned: {
      backgroundColor: colors.surface,
      borderLeftWidth: 3,
      borderLeftColor: colors.accent,
      paddingLeft: spacing.xl - 3,
    },
    // Socket down — last-known status, dimmed so it doesn't imply liveness.
    rowStale: { opacity: 0.55 },
    rowBody: { flex: 1 },
    rowTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
    agentName: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold, flexShrink: 1 },
    agentNameUnread: { fontWeight: typography.weightBold },
    agentNameQuiet: { color: colors.textMuted },
    mutedGlyph: { marginLeft: 5 },
    pinGlyph: { marginLeft: 5, transform: [{ rotate: '45deg' }] },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.warn },
    statusText: { color: colors.warn, fontSize: typography.sizeMd, fontWeight: typography.weightMedium },
    preview: { color: colors.textMuted, fontSize: typography.sizeMd },
    previewUnread: { color: colors.text },
    previewEmpty: { color: colors.textFaint, fontSize: typography.sizeMd, fontStyle: 'italic' },
    // Stacked trailing column: count badge over time, both centered on the axis.
    trailing: { alignItems: 'center', justifyContent: 'center', minWidth: 36, gap: 5 },
    timestamp: { color: colors.textDim, fontSize: typography.sizeSm },
    unreadPill: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      paddingHorizontal: 6,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    unreadPillMuted: { backgroundColor: colors.surface3 ?? colors.surface2 },
    unreadPillText: {
      color: colors.textOnAccent,
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
    },
    unreadPillTextMuted: { color: colors.textMuted },
    // Connection banner shown above the list while the socket is reconnecting/down.
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.xl,
      paddingVertical: 9,
      backgroundColor: colors.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    bannerText: { fontSize: typography.sizeMd, fontWeight: typography.weightMedium },
    bannerHint: { color: colors.textDim, fontSize: typography.sizeSm, marginLeft: 'auto' },
  })
}
