/**
 * Channel list for one server — the middle tier of the Server → Channel
 * drill-down. Tap the server on the home screen to get here; tap a channel to
 * open its chat. A gear opens the server's settings (avatar, mono-channel).
 *
 * Channels are "created + discovered": the user can create one with the ＋
 * button, and channels also appear automatically as inbound events reference
 * them (the WebSocket handler upserts the channel row before fan-out, so we just
 * re-read on each event for this server). A 'general' channel is ensured on
 * mount so a fresh server is never empty.
 *
 * Mono-channel servers (e.g. Claude Code) skip this screen entirely — the home
 * row opens the chat directly. If a mono-channel server is reached here anyway
 * (deep link, advertised default arriving late), we redirect to its chat.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useDB } from '../../../db/DBProvider'
import { useWS } from '../../../context/WebSocketContext'
import { useTheme } from '../../../context/ThemeContext'
import { AppHeader } from '../../../components/headers/AppHeader'
import { StatusIcon } from '../../../components/headers/StatusIcon'
import { ServerAvatar } from '../../../components/ServerAvatar'
import { SwipeableRow, type SwipeAction, type OpenSide } from '../../../components/SwipeableRow'
import {
  serverDisplayName,
  getChannelsForServer,
  getUnreadChannelCounts,
  getServer,
  isMonoChannel,
  upsertChannel,
  deleteChannel,
  DEFAULT_CHANNEL,
  type ChannelRow,
  type ServerRow,
} from '../../../db/database'
import type { ServerEvent } from '@aji/protocol'
import { spacing, typography, radius } from '../../../constants/theme'
import type { ThemeColors } from '../../../constants/theme'

// Slab tint for the delete action — same convention as the server list.
const ACTION_TINTS = { delete: '#C0453E' } as const

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

/** Normalize a user-typed channel name into a safe channel id. */
function normalizeChannelId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ServerChannelsScreen() {
  const { serverId } = useLocalSearchParams<{ serverId?: string | string[] }>()
  const resolvedServerId = useMemo(() => {
    if (Array.isArray(serverId)) return serverId[0] ?? undefined
    return serverId?.trim() ? serverId : undefined
  }, [serverId])

  const db = useDB()
  const { conn, subscribe, sendEvent } = useWS()
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({})
  const [server, setServer] = useState<ServerRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  // Optional working directory for the new session's terminal (Claude Code). Blank
  // ⇒ the launcher's default project dir.
  const [newCwd, setNewCwd] = useState('')
  // Which row + side has its swipe drawer open (one at a time).
  const [open, setOpen] = useState<{ id: string; side: OpenSide } | null>(null)

  const serverName = resolvedServerId ? serverDisplayName(resolvedServerId) : 'Server'

  // Ensure a default channel exists, then load the channel list. Also redirect
  // to the single chat if this server turns out to be mono-channel.
  useEffect(() => {
    if (!resolvedServerId) return
    let cancelled = false

    async function load() {
      const serverRow = await getServer(db, resolvedServerId!)
      if (serverRow && isMonoChannel(serverRow)) {
        router.replace(`/chat/${resolvedServerId}/${DEFAULT_CHANNEL}`)
        return
      }
      if (!cancelled) setServer(serverRow)
      await upsertChannel(db, resolvedServerId!, DEFAULT_CHANNEL)
      const rows = await getChannelsForServer(db, resolvedServerId!)
      if (!cancelled) setChannels(rows)
      const counts = await getUnreadChannelCounts(db, resolvedServerId!)
      if (!cancelled) setUnreadCounts(counts)
    }
    load().catch((err) => console.warn('[ServerChannels] load failed', err))

    return () => {
      cancelled = true
    }
  }, [db, resolvedServerId])

  // Refresh unread counts whenever the screen regains focus — covers returning
  // from a channel chat, which marks that channel read with no WS event to catch.
  // Also ask the agent which sessions are still alive so channels whose terminal
  // is gone get archived (the agent replies with a `sessions` event the WS handler
  // reconciles, then the live-refresh subscription below re-reads the list).
  useFocusEffect(
    useCallback(() => {
      if (!resolvedServerId) return
      let cancelled = false
      sendEvent({ type: 'get_sessions', serverId: resolvedServerId })
      getUnreadChannelCounts(db, resolvedServerId)
        .then((counts) => { if (!cancelled) setUnreadCounts(counts) })
        .catch((err) => console.warn('[ServerChannels] unread refresh failed', err))
      return () => { cancelled = true }
    }, [db, resolvedServerId, sendEvent]),
  )

  // Live refresh: re-read whenever an event for this server arrives (the WS
  // handler has already persisted + upserted the channel by the time we run).
  useEffect(() => {
    if (!resolvedServerId) return
    return subscribe('*', (event: ServerEvent) => {
      const evServer = ('serverId' in event ? event.serverId : undefined) ?? 'unknown'
      if (evServer !== resolvedServerId) return
      if (event.type === 'text_delta') return // no row change between deltas
      getChannelsForServer(db, resolvedServerId)
        .then(setChannels)
        .catch((err) => console.warn('[ServerChannels] live refresh failed', err))
      getUnreadChannelCounts(db, resolvedServerId)
        .then(setUnreadCounts)
        .catch((err) => console.warn('[ServerChannels] unread refresh failed', err))
      getServer(db, resolvedServerId)
        .then(setServer)
        .catch((err) => console.warn('[ServerChannels] server refresh failed', err))
    })
  }, [subscribe, db, resolvedServerId])

  const openChannel = (channelId: string) => {
    if (!resolvedServerId) return
    router.push(`/chat/${resolvedServerId}/${channelId}`)
  }

  // Delete a channel: drop it locally (row + message history) and tell the server
  // to remove it from the registry so a reconnect/replay won't resurrect it. The
  // 'general' default is not deletable — the screen re-ensures it on mount.
  const deleteChannelFlow = useCallback(
    async (channelId: string) => {
      if (!resolvedServerId || channelId === DEFAULT_CHANNEL) return
      setChannels((prev) => prev.filter((c) => c.channel_id !== channelId))
      sendEvent({ type: 'delete_channel', serverId: resolvedServerId, channel: channelId })
      try {
        await deleteChannel(db, resolvedServerId, channelId)
      } catch (err) {
        console.warn('[ServerChannels] delete failed', err)
      }
    },
    [db, resolvedServerId, sendEvent],
  )

  const confirmDelete = useCallback(
    (channel: ChannelRow) => {
      if (channel.channel_id === DEFAULT_CHANNEL) return
      Alert.alert(
        `Delete #${channel.display_name}?`,
        'This removes the channel and its messages on this device.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => deleteChannelFlow(channel.channel_id).catch(console.warn),
          },
        ],
      )
    },
    [deleteChannelFlow],
  )

  const showDefaultDeleteBlocked = useCallback(() => {
    Alert.alert(
      'Default channel',
      'The default #general channel cannot be deleted.',
      [{ text: 'OK' }],
    )
  }, [])

  // Swipe actions for a channel row. The default channel still shows Delete so
  // users discover the affordance, but tapping explains why it is blocked.
  const actionsFor = useCallback((channel: ChannelRow): SwipeAction[] => {
    return [
      {
        key: 'delete',
        icon: <Feather name="trash-2" size={20} color="#fff" />,
        label: 'Delete',
        color: ACTION_TINTS.delete,
        onPress: () => {
          if (channel.channel_id === DEFAULT_CHANNEL) {
            showDefaultDeleteBlocked()
            return
          }
          confirmDelete(channel)
        },
      },
    ]
  }, [confirmDelete, showDefaultDeleteBlocked])

  const dismissCreate = useCallback(() => {
    setCreating(false)
    setNewName('')
    setNewCwd('')
  }, [])

  const createChannel = async () => {
    const id = normalizeChannelId(newName)
    const cwd = newCwd.trim() || undefined
    setCreating(false)
    setNewName('')
    setNewCwd('')
    if (!id || !resolvedServerId) return
    // Optimistic local write for a snappy create→open; the server owns the
    // channel registry and broadcasts the authoritative `channels` list back,
    // which the WS handler reconciles into this same table. The cwd rides along
    // so the agent's launcher can spawn this session's terminal in that directory.
    await upsertChannel(db, resolvedServerId, id, undefined, cwd)
    sendEvent({ type: 'create_channel', serverId: resolvedServerId, channel: id, ...(cwd ? { cwd } : {}) })
    setChannels(await getChannelsForServer(db, resolvedServerId))
    openChannel(id)
  }

  return (
    <View style={styles.screen}>
      <AppHeader
        left={
          <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
        }
        title={
          <View style={styles.titleRow}>
            <ServerAvatar
              avatar={server?.avatar}
              label={serverName}
              size={30}
            />
            <Text style={styles.title} numberOfLines={1}>{serverName}</Text>
          </View>
        }
        right={
          <View style={styles.rightRow}>
            <StatusIcon
              color={conn === 'connected' ? colors.success : conn === 'connecting' ? colors.warn : colors.danger}
              pulse={conn === 'connecting'}
              accessibilityLabel={`Connection ${conn}`}
            />
            <Pressable
              onPress={() => resolvedServerId && router.push(`/server/${resolvedServerId}/settings`)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Server settings"
            >
              <Feather name="settings" size={20} color={colors.textMuted} />
            </Pressable>
            <Pressable
              style={styles.addBtn}
              onPress={() => setCreating(true)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="New channel"
            >
              <Text style={styles.addBtnText}>+</Text>
            </Pressable>
          </View>
        }
      />

      {/* New-channel modal */}
      <Modal visible={creating} transparent animationType="fade" onRequestClose={dismissCreate}>
        <KeyboardAvoidingView
          style={styles.modalFlex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable style={styles.modalBackdrop} onPress={dismissCreate}>
            <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.cardTitle}>New channel</Text>
            <View style={styles.inputRow}>
              <Text style={styles.hash}>#</Text>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="channel-name"
                placeholderTextColor={colors.textFaint}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                returnKeyType="next"
              />
            </View>
            <View style={styles.inputRow}>
              <Feather name="folder" size={15} color={colors.textDim} />
              <TextInput
                value={newCwd}
                onChangeText={setNewCwd}
                placeholder="working directory (optional)"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                onSubmitEditing={() => createChannel().catch(console.warn)}
                returnKeyType="done"
              />
            </View>
            <Text style={styles.cardHint}>
              Each channel is its own Claude Code session. Leave the directory blank to use the default project.
            </Text>
            <Pressable style={styles.createBtn} onPress={() => createChannel().catch(console.warn)}>
              <Text style={styles.createBtnText}>Create</Text>
            </Pressable>
          </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <FlatList
        data={channels}
        keyExtractor={(c) => c.channel_id}
        contentContainerStyle={styles.list}
        onScrollBeginDrag={() => setOpen(null)}
        renderItem={({ item }) => (
          <SwipeableRow
            actions={actionsFor(item)}
            openSide={open?.id === item.channel_id ? open.side : null}
            onOpenSide={(side) => setOpen(side ? { id: item.channel_id, side } : null)}
            onPress={() => openChannel(item.channel_id)}
          >
            <ChannelListRow
              item={item}
              isDefault={item.channel_id === DEFAULT_CHANNEL}
              unreadCount={unreadCounts[item.channel_id] ?? 0}
              styles={styles}
              colors={colors}
            />
          </SwipeableRow>
        )}
      />
    </View>
  )
}

// ---------------------------------------------------------------------------
// ChannelListRow — presentational. Tap/swipe handling lives in SwipeableRow.
// ---------------------------------------------------------------------------

function ChannelListRow({
  item,
  isDefault,
  unreadCount,
  styles,
  colors,
}: {
  item: ChannelRow
  isDefault: boolean
  unreadCount: number
  styles: ReturnType<typeof makeStyles>
  colors: ThemeColors
}) {
  const unread = unreadCount > 0
  const archived = item.archived === 1
  // Archived = the backing terminal is gone, so any lingering thinking/working
  // status is stale — don't show it as live.
  const active = !archived && (item.last_status === 'thinking' || item.last_status === 'working')
  const time = relativeTime(item.last_event_at)
  return (
    <View style={[styles.rowInner, archived && styles.rowInnerArchived]}>
      <ChannelBadge unread={unread} colors={colors} styles={styles} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text
            style={[styles.channelName, unread && styles.channelNameUnread, archived && styles.channelNameArchived]}
            numberOfLines={1}
          >
            {item.display_name}
          </Text>
          {archived ? (
            <View style={styles.archivedPill}>
              <Text style={styles.archivedPillText}>Archived</Text>
            </View>
          ) : isDefault ? (
            <View style={styles.defaultPill}>
              <Text style={styles.defaultPillText}>Default</Text>
            </View>
          ) : null}
        </View>
        {active ? (
          <View style={styles.statusRow}>
            <View style={styles.statusDot} />
            <Text style={styles.statusText} numberOfLines={1}>
              {item.last_status === 'thinking' ? 'thinking…' : 'working…'}
            </Text>
          </View>
        ) : item.last_message_preview ? (
          <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
            {item.last_message_preview}
          </Text>
        ) : (
          <Text style={styles.previewEmpty}>No messages yet</Text>
        )}
      </View>
      <View style={styles.trailing}>
        {unread && (
          <View style={styles.unreadPill}>
            <Text style={styles.unreadPillText} numberOfLines={1}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
          </View>
        )}
        {time ? <Text style={styles.timestamp}>{time}</Text> : null}
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// ChannelBadge — rounded-square '#' tile. The square shape (vs. the round
// ServerAvatar) signals "channel, not server" at a glance. An unread channel
// tints the tile + glyph gold; a read one stays muted. Live status moved to the
// row's status text line, mirroring the home-screen treatment.
// ---------------------------------------------------------------------------

function ChannelBadge({
  unread,
  colors,
  styles,
}: {
  unread: boolean
  colors: ThemeColors
  styles: ReturnType<typeof makeStyles>
}) {
  return (
    <View style={[styles.badge, unread && styles.badgeUnread]}>
      <Text style={[styles.badgeHash, unread && styles.badgeHashUnread]}>#</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    backBtn: { paddingRight: 4 },
    backText: { color: colors.accent, fontSize: 28, lineHeight: 32 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    title: { color: colors.text, fontSize: typography.sizeXl, fontWeight: typography.weightSemibold, flexShrink: 1 },
    rightRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    addBtn: {
      width: 32,
      height: 32,
      borderRadius: radius.full,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addBtnText: { color: colors.textOnAccent, fontSize: typography.sizeLg, lineHeight: 20 },

    modalFlex: { flex: 1 },
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
    card: {
      width: 300,
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.md,
    },
    cardTitle: {
      color: colors.textDim,
      fontSize: typography.sizeSm,
      fontWeight: typography.weightSemibold,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
    },
    hash: { color: colors.textDim, fontSize: typography.sizeLg },
    input: { flex: 1, color: colors.text, fontSize: typography.sizeLg, paddingVertical: 10 },
    cardHint: { color: colors.textFaint, fontSize: typography.sizeSm, lineHeight: 16 },
    createBtn: {
      backgroundColor: colors.accent,
      borderRadius: radius.md,
      paddingVertical: 12,
      alignItems: 'center',
    },
    createBtnText: { color: colors.bg, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold },

    list: { marginTop: spacing.sm },
    rowInner: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.xl,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    rowInnerArchived: { opacity: 0.5 },
    badge: {
      width: 40,
      height: 40,
      borderRadius: radius.lg,
      backgroundColor: colors.surface2 ?? colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeUnread: { backgroundColor: colors.surface3 ?? colors.surface2 },
    badgeHash: {
      color: colors.textMuted,
      fontSize: typography.size2xl,
      fontWeight: typography.weightSemibold,
      lineHeight: typography.size2xl + 2,
    },
    badgeHashUnread: { color: colors.accent, fontWeight: typography.weightBold },
    rowBody: { flex: 1 },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
    channelName: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold, flexShrink: 1 },
    channelNameUnread: { fontWeight: typography.weightBold },
    channelNameArchived: { color: colors.textMuted, fontWeight: typography.weightMedium },
    defaultPill: {
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface2 ?? colors.surface,
      paddingHorizontal: 8,
      height: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    defaultPillText: {
      color: colors.textDim,
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
      lineHeight: 14,
      textTransform: 'uppercase',
    },
    archivedPill: {
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: 'transparent',
      paddingHorizontal: 8,
      height: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    archivedPillText: {
      color: colors.textMuted,
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
      lineHeight: 14,
      textTransform: 'uppercase',
    },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.warn },
    statusText: { color: colors.warn, fontSize: typography.sizeMd, fontWeight: typography.weightMedium },
    timestamp: { color: colors.textDim, fontSize: typography.sizeSm },
    preview: { color: colors.textMuted, fontSize: typography.sizeMd },
    previewUnread: { color: colors.text },
    previewEmpty: { color: colors.textFaint, fontSize: typography.sizeMd, fontStyle: 'italic' },
    // Stacked trailing column: unread pill over time, centered on the axis.
    trailing: { alignItems: 'center', justifyContent: 'center', minWidth: 32, gap: 5 },
    unreadPill: {
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 6,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    unreadPillText: {
      color: colors.textOnAccent,
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
    },
  })
}
