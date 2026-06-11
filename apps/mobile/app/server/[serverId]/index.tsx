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
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { router, useLocalSearchParams } from 'expo-router'
import { useDB } from '../../../db/DBProvider'
import { useWS } from '../../../context/WebSocketContext'
import { useTheme } from '../../../context/ThemeContext'
import { AppHeader } from '../../../components/headers/AppHeader'
import { StatusIcon } from '../../../components/headers/StatusIcon'
import { ServerAvatar } from '../../../components/ServerAvatar'
import { DraggableList } from '../../../components/chat/DraggableList'
import {
  serverDisplayName,
  getChannelsForServer,
  getServer,
  isMonoChannel,
  upsertChannel,
  deleteChannel,
  setChannelOrder,
  DEFAULT_CHANNEL,
  type ChannelRow,
  type ServerRow,
} from '../../../db/database'
import type { ServerEvent } from '@aji/protocol'
import { spacing, typography, radius } from '../../../constants/theme'
import type { ThemeColors } from '../../../constants/theme'

// Fixed channel-row height — DraggableList absolutely positions rows by index,
// so this must match the rendered row's total height.
const ROW_H = 68

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
  const [server, setServer] = useState<ServerRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState(false)

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
    }
    load().catch((err) => console.warn('[ServerChannels] load failed', err))

    return () => {
      cancelled = true
    }
  }, [db, resolvedServerId])

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
      getServer(db, resolvedServerId)
        .then(setServer)
        .catch((err) => console.warn('[ServerChannels] server refresh failed', err))
    })
  }, [subscribe, db, resolvedServerId])

  const openChannel = (channelId: string) => {
    if (!resolvedServerId) return
    router.push(`/chat/${resolvedServerId}/${channelId}`)
  }

  // Persist a drag-reordered channel list. Reorder local state first so the row
  // order matches the drop immediately, then write positions to SQLite.
  const handleReorder = useCallback(
    (orderedIds: string[]) => {
      if (!resolvedServerId) return
      setChannels((prev) => {
        const byId = new Map(prev.map((c) => [c.channel_id, c]))
        return orderedIds
          .map((id) => byId.get(id))
          .filter((c): c is ChannelRow => Boolean(c))
      })
      setChannelOrder(db, resolvedServerId, orderedIds).catch((err) =>
        console.warn('[ServerChannels] reorder persist failed', err),
      )
    },
    [db, resolvedServerId],
  )

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

  const createChannel = async () => {
    const id = normalizeChannelId(newName)
    setCreating(false)
    setNewName('')
    if (!id || !resolvedServerId) return
    // Optimistic local write for a snappy create→open; the server owns the
    // channel registry and broadcasts the authoritative `channels` list back,
    // which the WS handler reconciles into this same table.
    await upsertChannel(db, resolvedServerId, id)
    sendEvent({ type: 'create_channel', serverId: resolvedServerId, channel: id })
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
              status={server?.last_status}
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
              onPress={() => setEditing((e) => !e)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={editing ? 'Done editing channels' : 'Edit channels'}
            >
              <Feather
                name={editing ? 'check' : 'edit-2'}
                size={20}
                color={editing ? colors.accent : colors.textMuted}
              />
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
      <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setCreating(false)}>
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
                onSubmitEditing={() => createChannel().catch(console.warn)}
                returnKeyType="done"
              />
            </View>
            <Pressable style={styles.createBtn} onPress={() => createChannel().catch(console.warn)}>
              <Text style={styles.createBtnText}>Create</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <DraggableList
        data={channels}
        keyExtractor={(c) => c.channel_id}
        rowHeight={ROW_H}
        onPressItem={(item) => (editing ? confirmDelete(item) : openChannel(item.channel_id))}
        onReorder={handleReorder}
        liftBackground={colors.surface2}
        contentStyle={styles.list}
        renderItem={(item, { isActive }) => (
          <View style={[styles.rowInner, isActive && styles.rowInnerActive]}>
            <ChannelBadge status={item.last_status} colors={colors} styles={styles} />
            <View style={styles.rowBody}>
              <View style={styles.rowTop}>
                <Text style={styles.channelName}>{item.display_name}</Text>
                <Text style={styles.timestamp}>{relativeTime(item.last_event_at)}</Text>
              </View>
              {item.last_message_preview ? (
                <Text style={styles.preview} numberOfLines={1}>{item.last_message_preview}</Text>
              ) : (
                <Text style={styles.previewEmpty}>No messages yet</Text>
              )}
            </View>
            {editing && item.channel_id !== DEFAULT_CHANNEL ? (
              <Feather name="minus-circle" size={20} color={colors.danger} />
            ) : (
              <Text style={styles.chevron}>›</Text>
            )}
          </View>
        )}
      />
    </View>
  )
}

// ---------------------------------------------------------------------------
// ChannelBadge — circular '#' avatar with a live status presence dot. Mirrors
// the home-screen ServerAvatar language so a channel row reads as a sibling of
// a server row rather than a bare text line.
// ---------------------------------------------------------------------------

function ChannelBadge({
  status,
  colors,
  styles,
}: {
  status: string
  colors: ThemeColors
  styles: ReturnType<typeof makeStyles>
}) {
  return (
    <View style={styles.badge} accessibilityLabel={`Channel status ${status}`}>
      <Text style={styles.badgeHash}>#</Text>
      <View style={styles.badgeDot}>
        <StatusIcon
          color={statusColor(status, colors)}
          size={9}
          pulse={status !== 'idle'}
        />
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
    backBtn: { paddingRight: 4 },
    backText: { color: colors.accent, fontSize: 28, lineHeight: 32 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    title: { color: colors.text, fontSize: typography.sizeXl, fontWeight: typography.weightSemibold, flexShrink: 1 },
    rightRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    addBtn: {
      width: 32,
      height: 32,
      borderRadius: radius.full,
      backgroundColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addBtnText: { color: colors.text, fontSize: typography.sizeLg, lineHeight: 20 },

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
    createBtn: {
      backgroundColor: colors.accent,
      borderRadius: radius.md,
      paddingVertical: 12,
      alignItems: 'center',
    },
    createBtnText: { color: colors.bg, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold },

    list: { marginTop: spacing.sm },
    rowInner: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.xl,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    rowInnerActive: {
      borderBottomColor: 'transparent',
      borderRadius: radius.lg,
    },
    badge: {
      width: 40,
      height: 40,
      borderRadius: radius.full,
      backgroundColor: colors.surface2 ?? colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeHash: {
      color: colors.textMuted,
      fontSize: typography.size2xl,
      fontWeight: typography.weightSemibold,
      lineHeight: typography.size2xl + 2,
    },
    badgeDot: {
      position: 'absolute',
      bottom: -1,
      right: -1,
      backgroundColor: colors.bg,
      borderRadius: radius.full,
      padding: 2,
    },
    rowBody: { flex: 1 },
    rowTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
    channelName: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold, flex: 1 },
    timestamp: { color: colors.textDim, fontSize: typography.sizeSm },
    preview: { color: colors.textMuted, fontSize: typography.sizeMd },
    previewEmpty: { color: colors.textFaint, fontSize: typography.sizeMd, fontStyle: 'italic' },
    chevron: { color: colors.textFaint, fontSize: typography.size2xl },
  })
}
