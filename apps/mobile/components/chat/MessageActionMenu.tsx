/**
 * MessageActionMenu — WhatsApp/Telegram-style long-press context menu.
 *
 * On long-press, the chat screen measures the pressed bubble's on-screen rect
 * and hands it here. This overlay then:
 *   - dims the whole screen with a scrim,
 *   - renders a clone of the message at its original position and lifts it
 *     toward the vertical center (translateY spring),
 *   - reveals an action list below the clone (icons + labels), aligned to the
 *     same side the bubble sits on (user → right, agent → left).
 *
 * It owns its own enter/exit animation so the parent only has to flip `target`
 * to a value (open) or null (the menu animates out, then calls `onClose`).
 *
 * Delete is local-only ("delete for me"): there is no protocol verb to delete a
 * single message on the agent side, and history is local-first, so removing it
 * from SQLite + the in-memory window is the whole operation. The parent wires
 * the actual side effects via onCopy / onDelete.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import {
  Animated,
  Dimensions,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import { stripStreamingCursor, messageCopyText } from '../../hooks/chatTypes'
import { fileViewerKind, fileIconName } from './fileHelpers'

// Re-exported so call sites that already render the menu can grab the copy text
// from one import; the implementation lives in chatTypes (pure, unit-tested).
export { messageCopyText }

export type Rect = { x: number; y: number; width: number; height: number }
export type MessageMenuTarget = { item: Item; rect: Rect }

type FeatherName = ComponentProps<typeof Feather>['name']
type MenuAction = { key: string; label: string; icon: FeatherName; destructive?: boolean; run: () => void }

const MENU_WIDTH = 220
const GAP = 12 // between clone and action list
const EDGE = 16 // min inset from screen edges

export function MessageActionMenu({
  target,
  onClose,
  onCopy,
  onDelete,
}: {
  target: MessageMenuTarget | null
  onClose: () => void
  onCopy: (item: Item) => void
  onDelete: (item: Item) => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const insets = useSafeAreaInsets()
  const { width: screenW, height: screenH } = Dimensions.get('window')

  // Keep rendering the last target through the exit animation so the menu can
  // fade/settle out after the parent clears `target`.
  const [local, setLocal] = useState<MessageMenuTarget | null>(null)
  const progress = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (target) {
      setLocal(target)
      progress.setValue(0)
      Animated.spring(progress, {
        toValue: 1,
        useNativeDriver: true,
        bounciness: 6,
        speed: 14,
      }).start()
    }
  }, [target, progress])

  const close = useCallback(() => {
    Animated.timing(progress, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
      if (finished) {
        setLocal(null)
        onClose()
      }
    })
  }, [progress, onClose])

  const actions = useMemo<MenuAction[]>(() => {
    if (!local) return []
    const { item } = local
    const list: MenuAction[] = []
    const copyText = messageCopyText(item)
    if (copyText) {
      list.push({ key: 'copy', label: 'Copy', icon: 'copy', run: () => onCopy(item) })
    }
    list.push({ key: 'delete', label: 'Delete', icon: 'trash-2', destructive: true, run: () => onDelete(item) })
    return list
  }, [local, onCopy, onDelete])

  if (!local) return null

  const { rect, item } = local
  const side: 'left' | 'right' = item.kind === 'message' || item.kind === 'file'
    ? (item.role === 'user' ? 'right' : 'left')
    : 'left'

  // Cap how tall the lifted clone can be so a long message still leaves room for
  // the menu; the preview itself clips with a fade-free maxHeight.
  const maxCloneH = screenH * 0.5
  const cloneH = Math.min(rect.height, maxCloneH)
  const menuH = actions.length * 48 + spacing.sm * 2
  const groupH = cloneH + GAP + menuH

  const topMin = insets.top + EDGE
  const topMax = screenH - insets.bottom - EDGE - groupH
  const targetTop = clamp((screenH - groupH) / 2, topMin, Math.max(topMin, topMax))
  const dy = targetTop - rect.y

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, dy] })

  // Right-aligned menu: align its right edge to the clone's right edge.
  const menuLeft = side === 'right'
    ? Math.max(EDGE, rect.x + rect.width - MENU_WIDTH)
    : Math.min(rect.x, screenW - MENU_WIDTH - EDGE)

  return (
    <Modal visible transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <Pressable style={StyleSheet.absoluteFill} onPress={close}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]} />

        {/* Lifted clone + action list, animated together. */}
        <Animated.View
          pointerEvents="box-none"
          style={[styles.group, { top: rect.y, transform: [{ translateY }] }]}
        >
          <View style={{ marginLeft: rect.x, width: rect.width, maxHeight: maxCloneH, overflow: 'hidden' }}>
            <MessagePreview item={item} colors={colors} styles={styles} width={rect.width} />
          </View>

          <Animated.View
            style={[
              styles.menu,
              { marginLeft: menuLeft, width: MENU_WIDTH, opacity: progress },
            ]}
          >
            {actions.map((action, i) => (
              <Pressable
                key={action.key}
                onPress={() => { action.run(); close() }}
                style={({ pressed }) => [
                  styles.menuItem,
                  i > 0 && styles.menuItemBorder,
                  pressed && styles.menuItemPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={action.label}
              >
                <Text style={[styles.menuLabel, action.destructive && styles.menuLabelDanger]}>
                  {action.label}
                </Text>
                <Feather
                  name={action.icon}
                  size={18}
                  color={action.destructive ? colors.danger : colors.text}
                />
              </Pressable>
            ))}
          </Animated.View>
        </Animated.View>
      </Pressable>
    </Modal>
  )
}

/** A faithful-enough, non-interactive clone of the message for the lift effect. */
function MessagePreview({
  item,
  colors,
  styles,
  width,
}: {
  item: Item
  colors: ThemeColors
  styles: ReturnType<typeof makeStyles>
  width: number
}) {
  if (item.kind === 'message') {
    const isUser = item.role === 'user'
    const text = isUser ? item.text : stripStreamingCursor(item.text)
    return (
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
        <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]} numberOfLines={16}>
          {text}
        </Text>
      </View>
    )
  }

  if (item.kind === 'file') {
    const kind = fileViewerKind(item)
    if (kind === 'image') {
      return (
        <Image
          source={{ uri: `data:${item.mime};base64,${item.data}` }}
          style={{ width, aspectRatio: 4 / 3, borderRadius: radius.lg, backgroundColor: colors.surface2 }}
          resizeMode="cover"
        />
      )
    }
    return (
      <View style={[styles.bubble, styles.bubbleAgent, styles.fileRow]}>
        <Feather name={fileIconName(item) as FeatherName} size={20} color={colors.accent} />
        <Text style={styles.fileName} numberOfLines={1}>{item.name ?? item.mime}</Text>
      </View>
    )
  }

  // Fallback (prompts etc. don't open the menu, but render something inert).
  return <View style={[styles.bubble, styles.bubbleAgent]} />
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    scrim: { backgroundColor: 'rgba(0,0,0,0.6)' },
    group: { position: 'absolute', left: 0, right: 0 },
    bubble: { borderRadius: radius.xl, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    bubbleAgent: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    bubbleUser: { backgroundColor: colors.accent },
    bubbleText: { color: colors.text, fontSize: typography.sizeLg, lineHeight: typography.lineHeightNormal },
    bubbleTextUser: { color: '#fff' },
    fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    fileName: { flex: 1, color: colors.text, fontSize: typography.sizeMd, fontWeight: typography.weightSemibold },
    menu: {
      marginTop: GAP,
      backgroundColor: colors.surface2,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.25,
      shadowRadius: 16,
      elevation: 8,
    },
    menuItem: {
      height: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
    },
    menuItemBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    menuItemPressed: { backgroundColor: colors.surface3 },
    menuLabel: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightMedium },
    menuLabelDanger: { color: colors.danger },
  })
}
