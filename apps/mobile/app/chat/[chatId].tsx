/**
 * Per-agent chat screen.
 *
 * Responsible only for rendering. All state management lives in:
 *  - useChatSession  — items, agent status, commands (WS + DB)
 *  - useChatActions  — sendMessage, respond, addSystemMessage
 *  - useChatAnimations — keyboard offset, status pulse
 */
import { Component, ReactNode, memo, useCallback, useMemo, useRef, useState } from 'react'
import {
  Animated,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { AgentStatus, CommandItem } from '@aji/protocol'
import { MarkdownMessage } from '../../components/MarkdownMessage'
import { useDB } from '../../db/DBProvider'
import { agentDisplayName } from '../../db/database'
import { useWS } from '../../context/WebSocketContext'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import { useChatSession } from '../../hooks/useChatSession'
import { useChatActions, LOCAL_COMMANDS } from '../../hooks/useChatActions'
import { useKeyboardOffset, usePulseAnimation } from '../../hooks/useChatAnimations'

export default function ChatScreen() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>()
  const db = useDB()
  const { conn, sendEvent, subscribe } = useWS()
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const { top: safeTop, bottom: safeBottom } = useSafeAreaInsets()
  const [draft, setDraft] = useState('')

  const { items, setItems, agentStatus, commands } = useChatSession(chatId, db, conn, subscribe)
  const { sendMessage, addSystemMessage, respond } = useChatActions({ chatId, db, conn, sendEvent, items, setItems })
  const kbOffset = useKeyboardOffset(safeBottom)
  const pulseScale = usePulseAnimation(agentStatus)

  const listRef = useRef<FlatList>(null)
  const isNearBottomRef = useRef(true)

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  // Pre-compute set of turnIds with at least one tool call — O(n) once, not O(n) per row
  const toolTurnIds = useMemo(
    () =>
      new Set(
        items
          .filter((it): it is Extract<Item, { kind: 'tool' }> => it.kind === 'tool')
          .map((it) => it.turnId)
          .filter((id): id is string => id != null),
      ),
    [items],
  )

  const allCommands = useMemo(() => [...LOCAL_COMMANDS, ...commands], [commands])

  const rawQuery = draft.startsWith('/') ? draft.slice(1) : null
  const pickerQuery = rawQuery !== null && !rawQuery.includes(' ') ? rawQuery.toLowerCase() : null

  const pickerItems = useMemo(() => {
    if (pickerQuery === null) return []
    return allCommands
      .filter((c) =>
        c.name.startsWith(pickerQuery) ||
        (c.aliases ?? []).some((a) => a.startsWith(pickerQuery)),
      )
      .slice(0, 20)
  }, [pickerQuery, allCommands])

  const showPicker = pickerItems.length > 0
  const canSend = draft.trim().length > 0 && conn === 'connected'
  const displayName = chatId ? agentDisplayName(chatId) : 'Chat'
  const avatarLabel = useMemo(() => getAvatarLabel(displayName), [displayName])

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSend = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    sendMessage(text)
    setDraft('')
  }, [draft, sendMessage])

  const renderItem = useCallback(
    ({ item, index }: { item: Item; index: number }) => {
      const prev = items[index - 1]
      const isGroupStart = computeIsGroupStart(item, prev)
      const isLast = index === items.length - 1
      const hasTool =
        item.kind === 'message' && item.turnId != null && toolTurnIds.has(item.turnId)
      return (
        <Row
          item={item}
          onChoose={respond}
          isGroupStart={isGroupStart}
          isLast={isLast}
          hasTool={hasTool}
          avatarLabel={avatarLabel}
        />
      )
    },
    [items, toolTurnIds, respond, avatarLabel],
  )

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Animated.View style={[styles.screen, { paddingTop: safeTop + 12, paddingBottom: kbOffset }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{displayName}</Text>
        <StatusIndicator status={agentStatus} pulseScale={pulseScale} connStatus={conn} />
      </View>

      {/* Message list */}
      {items.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.empty}>No messages yet</Text>
        </View>
      ) : (
        <MessageListErrorBoundary colors={colors}>
          <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(it) => `${it.kind}-${it.id}`}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            onScroll={({ nativeEvent }) => {
              const { contentOffset, contentSize, layoutMeasurement } = nativeEvent
              isNearBottomRef.current =
                contentSize.height - contentOffset.y - layoutMeasurement.height < 150
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (isNearBottomRef.current) listRef.current?.scrollToEnd({ animated: true })
            }}
          />
        </MessageListErrorBoundary>
      )}

      {/* Slash command picker */}
      {showPicker && (
        <CommandPicker items={pickerItems} onSelect={(name) => setDraft(`/${name} `)} />
      )}

      {/* Composer */}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message…"
          placeholderTextColor={colors.textDim}
          returnKeyType="send"
          onSubmitEditing={handleSend}
        />
        <Pressable
          style={[styles.sendBtn, !canSend && styles.sendBtnOff]}
          onPress={handleSend}
          disabled={!canSend}
        >
          <Text style={styles.sendBtnText}>↑</Text>
        </Pressable>
      </View>
    </Animated.View>
  )
}

// ---------------------------------------------------------------------------
// endering helpers
// ---------------------------------------------------------------------------

// Regex matching common streaming cursor glyphs and simple ANSI show/hide sequences
const STREAM_CURSOR_RE = /\s*(?:▉|▍|█|▌|\||_|\x1b\[\?25[lh])\s*$/

function stripStreamingCursor(text: string): string {
  return text.replace(STREAM_CURSOR_RE, '')
}

function getAvatarLabel(displayName: string): string {
  const words = displayName.trim().split(/\s+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return displayName.slice(0, 2).toUpperCase()
}

/**
 * A message is the start of a new group when:
 * - It is the first item in the list, OR
 * - The previous item is from a different sender, OR
 * - The previous item is a tool/prompt (breaks grouping), OR
 * - The items belong to different turns.
 */
function computeIsGroupStart(item: Item, prev: Item | undefined): boolean {
  if (!prev) return true
  if (item.kind !== 'message') return true
  if (prev.kind !== 'message') return true
  if (item.role !== prev.role) return true
  if (item.turnId && prev.turnId && item.turnId === prev.turnId) return false
  return true
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

class MessageListErrorBoundary extends Component<
  { children: ReactNode; colors: ThemeColors },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <Text style={{ color: this.props.colors.danger, textAlign: 'center' }}>
            Something went wrong rendering messages. Navigate away and back to recover.
          </Text>
        </View>
      )
    }
    return this.props.children
  }
}

function Avatar({ label, variant }: { label: string; variant: 'agent' | 'user' }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={[styles.avatar, variant === 'user' && styles.avatarUser]}>
      <Text style={[styles.avatarText, variant === 'user' && styles.avatarTextUser]}>
        {label}
      </Text>
    </View>
  )
}

function StatusIndicator({
  status,
  pulseScale,
  connStatus,
}: {
  status: AgentStatus
  pulseScale: Animated.Value
  connStatus: 'connected' | 'connecting' | 'disconnected'
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const statusColor = status === 'idle'
    ? colors.success
    : status === 'thinking'
      ? colors.warn
      : colors.accent

  return (
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
  )
}

function PromptRow({
  item,
  onChoose,
}: {
  item: Extract<Item, { kind: 'prompt' }>
  onChoose: (id: string, choice: string) => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [textValues, setTextValues] = useState<Record<string, string>>({})
  const buttonOpts = item.options.filter((o) => !o.allowText)
  const textOpts = item.options.filter((o) => o.allowText)

  return (
    <View style={styles.promptCard}>
      <Text style={styles.promptTitle}>{item.title}</Text>
      <Text style={styles.promptMsg}>{item.message}</Text>
      {buttonOpts.length > 0 && (
        <View style={styles.promptBtns}>
          {buttonOpts.map((opt, i) => (
            <Pressable
              key={opt.id}
              style={styles.promptBtn}
              onPress={() => onChoose(item.id, opt.id)}
            >
              <Text style={styles.promptBtnNum}>{i + 1}</Text>
              <Text style={styles.promptBtnText}>{opt.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {textOpts.map((opt) => (
        <View key={opt.id} style={styles.textOptWrap}>
          <Text style={styles.textOptLabel}>{opt.label}</Text>
          <View style={styles.textOptRow}>
            <TextInput
              style={styles.textOptInput}
              value={textValues[opt.id] ?? ''}
              onChangeText={(v) => setTextValues((prev) => ({ ...prev, [opt.id]: v }))}
              placeholder="Type your answer…"
              placeholderTextColor={colors.textDim}
              returnKeyType="send"
              onSubmitEditing={() => {
                const val = (textValues[opt.id] ?? '').trim()
                if (val) onChoose(item.id, val)
              }}
            />
            <Pressable
              style={[styles.textOptBtn, !(textValues[opt.id] ?? '').trim() && styles.textOptBtnOff]}
              disabled={!(textValues[opt.id] ?? '').trim()}
              onPress={() => {
                const val = (textValues[opt.id] ?? '').trim()
                if (val) onChoose(item.id, val)
              }}
            >
              <Text style={styles.textOptBtnText}>→</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  )
}

function CommandPicker({
  items,
  onSelect,
}: {
  items: CommandItem[]
  onSelect: (name: string) => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.pickerWrap}>
      <FlatList
        data={items}
        keyExtractor={(c) => c.name}
        keyboardShouldPersistTaps="always"
        style={styles.pickerList}
        renderItem={({ item: cmd }) => (
          <Pressable style={styles.pickerRow} onPress={() => onSelect(cmd.name)}>
            <View style={styles.pickerLeft}>
              <Text style={styles.pickerName}>/{cmd.name}</Text>
              {cmd.args_hint && <Text style={styles.pickerHint}> {cmd.args_hint}</Text>}
            </View>
            <Text style={styles.pickerDesc} numberOfLines={1}>{cmd.description}</Text>
          </Pressable>
        )}
      />
    </View>
  )
}

const Row = memo(function Row({
  item,
  onChoose,
  isGroupStart,
  isLast,
  hasTool,
  avatarLabel,
}: {
  item: Item
  onChoose: (id: string, choice: string) => void
  isGroupStart: boolean
  isLast: boolean
  hasTool: boolean
  avatarLabel: string
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  if (item.kind === 'message') {
    const isUser = item.role === 'user'
    const displayText = isUser ? item.text : stripStreamingCursor(item.text)
    const showBubble = isUser || hasTool

    return (
      <View style={[styles.msgWrapper, !isLast && styles.msgBorder]}>
        {isGroupStart && (
          <View style={[styles.msgMeta, isUser && styles.msgMetaUserRight]}>
            {!isUser && <Avatar label={avatarLabel} variant="agent" />}
          </View>
        )}
        <View style={isUser ? styles.msgAlignRight : styles.msgAlignLeft}>
          <View style={[
            showBubble && styles.bubble,
            isUser ? styles.bubbleUser : showBubble && styles.bubbleAgent,
          ]}>
            {isUser || !item.done ? (
              <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
                {displayText}{!item.done && <Text style={styles.cursor}> ▍</Text>}
              </Text>
            ) : (
              <MarkdownMessage content={displayText} />
            )}
          </View>
        </View>
      </View>
    )
  }

  if (item.kind === 'tool') {
    return (
      <View style={[styles.toolCard, !isLast && styles.msgBorder]}>
        <Text style={styles.toolLabel}>🔧 {item.name} {item.done ? '✓' : '…'}</Text>
        <Text style={styles.toolMono}>{JSON.stringify(item.args)}</Text>
        {item.done && item.result !== undefined && (
          <Text style={styles.toolMono}>
            {typeof item.result === 'string' ? item.result : JSON.stringify(item.result)}
          </Text>
        )}
      </View>
    )
  }

  return <PromptRow item={item} onChoose={onChoose} />
})

// ---------------------------------------------------------------------------
// Style factory — called once per theme change via useMemo
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.sm,
    },
    backBtn: { paddingRight: spacing.xs },
    backText: { color: colors.accent, fontSize: 28, lineHeight: 32 },
    title: { color: colors.text, fontSize: typography.sizeXl, fontWeight: typography.weightSemibold, flex: 1 },
    statusContainer: { position: 'relative', width: 12, height: 12, alignItems: 'center', justifyContent: 'center' },
    statusDot: { width: 8, height: 8, borderRadius: radius.full },
    connDot: { position: 'absolute', width: 4, height: 4, borderRadius: radius.full, bottom: 0, right: 0 },
    emptyWrap: { flex: 1, justifyContent: 'center' },
    empty: { color: colors.textDim, textAlign: 'center', fontSize: typography.sizeLg },
    list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
    msgWrapper: { flexDirection: 'column', paddingVertical: spacing.sm },
    msgBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      paddingBottom: spacing.md,
      marginBottom: spacing.xs,
    },
    msgMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
    msgMetaUserRight: {},
    avatar: {
      width: 28,
      height: 28,
      borderRadius: radius.md,
      backgroundColor: colors.toolDim,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: colors.tool, fontSize: typography.sizeSm, fontWeight: typography.weightSemibold },
    avatarUser: { backgroundColor: colors.accentDim },
    avatarTextUser: { color: colors.accent },
    msgAuthor: { color: colors.textMuted, fontSize: typography.sizeSm, fontWeight: typography.weightSemibold, flex: 1 },
    msgAlignLeft: { alignItems: 'flex-start' },
    msgAlignRight: { alignItems: 'flex-end' },
    bubble: { borderRadius: radius.xl, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    bubbleAgent: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    bubbleUser: { backgroundColor: colors.accent, maxWidth: '85%' },
    bubbleText: { color: colors.text, fontSize: typography.sizeLg, lineHeight: typography.lineHeightNormal },
    bubbleTextUser: { color: '#fff' },
    cursor: { color: colors.accent },
    toolCard: {
      backgroundColor: colors.surface2,
      borderRadius: radius.lg,
      padding: spacing.md,
      borderLeftWidth: 3,
      borderLeftColor: colors.tool,
    },
    toolLabel: { color: colors.tool, fontSize: typography.sizeMd, fontWeight: typography.weightSemibold, marginBottom: 4 },
    toolMono: { color: colors.textMuted, fontSize: typography.sizeSm, fontFamily: typography.fontMono, marginTop: 2 },
    promptCard: {
      backgroundColor: colors.surface3,
      borderRadius: radius.xl,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.warn,
    },
    promptTitle: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold, marginBottom: 4 },
    promptMsg: { color: colors.textMuted, fontSize: typography.size, marginBottom: spacing.md },
    promptBtns: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
    promptBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.accent,
      paddingHorizontal: 14,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
    },
    promptBtnNum: { color: 'rgba(255,255,255,0.6)', fontSize: typography.sizeXs, fontWeight: typography.weightBold, minWidth: 14, textAlign: 'center' },
    promptBtnText: { color: '#fff', fontSize: typography.sizeMd, fontWeight: typography.weightSemibold },
    textOptWrap: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.borderAlt, paddingTop: 10 },
    textOptLabel: { color: colors.textMuted, fontSize: typography.sizeSm, fontWeight: typography.weightSemibold, marginBottom: 6 },
    textOptRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    textOptInput: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 10,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: colors.text,
      fontSize: typography.size,
      borderWidth: 1,
      borderColor: colors.borderAlt,
    },
    textOptBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    textOptBtnOff: { backgroundColor: colors.border },
    textOptBtnText: { color: '#fff', fontSize: 18, fontWeight: typography.weightBold },
    composer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      gap: spacing.sm,
    },
    input: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 20,
      paddingHorizontal: spacing.lg,
      paddingVertical: 10,
      color: colors.text,
      fontSize: typography.sizeLg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    sendBtnOff: { backgroundColor: colors.border },
    sendBtnText: { color: '#fff', fontSize: 18, fontWeight: typography.weightBold, lineHeight: 22 },
    pickerWrap: { maxHeight: 260, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
    pickerList: { flexGrow: 0 },
    pickerRow: {
      paddingHorizontal: spacing.lg,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    pickerLeft: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 2 },
    pickerName: { color: colors.accent, fontSize: typography.size, fontWeight: typography.weightSemibold },
    pickerHint: { color: colors.textMuted, fontSize: typography.sizeSm, fontStyle: 'italic' },
    pickerDesc: { color: colors.textDim, fontSize: typography.sizeSm },
  })
}
