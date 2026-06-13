/**
 * SwipeableRow — Telegram-style swipe-to-reveal row actions.
 *
 * Left-swipe reveals **trailing** actions as full-height, individually-tinted
 * slabs pinned to the right edge. A right-swipe reveals an optional **leading**
 * action (e.g. pin) on the left edge. Both directions open and *stay* open —
 * the revealed slab is then tapped to fire the action (slide, then tap).
 *
 * Built on core React Native `PanResponder` + `Animated` (the app doesn't depend
 * on react-native-gesture-handler) — mirroring DraggableList's "core RN only"
 * approach.
 *
 * Open state is **controlled** by the parent (`openSide` / `onOpenSide`) so only
 * one row — and one side — is open at a time.
 */
import { useEffect, useMemo, useRef } from 'react'
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../context/ThemeContext'
import { typography } from '../constants/theme'
import type { ThemeColors } from '../constants/theme'
import { selectionHaptic } from '../utils/haptics'

export type SwipeAction = {
  key: string
  /** Icon element, sized + colored by the caller (slabs expect white glyphs). */
  icon: React.ReactNode
  label: string
  /** Slab background tint. */
  color: string
  onPress: () => void
}

export type OpenSide = 'leading' | 'trailing' | null

// Full-height slab width — shared by the leading (pin) and trailing actions so
// both swipe directions render identically.
const SLAB_WIDTH = 76
// Horizontal travel (px) that must dominate vertical travel before we claim the
// gesture from the enclosing FlatList's vertical scroll.
const CLAIM_THRESHOLD = 10

type Props = {
  children: React.ReactNode
  actions: SwipeAction[]
  openSide: OpenSide
  onOpenSide: (side: OpenSide) => void
  /** Tap on the row body when closed. (When open, a tap just closes the row.) */
  onPress: () => void
  /** Optional right-swipe action (e.g. pin) revealed on the left edge. */
  leadingAction?: SwipeAction
}

export function SwipeableRow({
  children,
  actions,
  openSide,
  onOpenSide,
  onPress,
  leadingAction,
}: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const trailingWidth = actions.length * SLAB_WIDTH
  const leadingWidth = leadingAction ? SLAB_WIDTH : 0
  const translateX = useRef(new Animated.Value(0)).current
  // Committed resting offset: 0 (closed), -trailingWidth (trailing open), or
  // +leadingWidth (leading open). Read on gesture grant so a drag continues from
  // the current position rather than snapping.
  const offset = useRef(0)

  const animateTo = (to: number) => {
    offset.current = to
    // JS-driven (not native) on purpose: the pan loop drives translateX via
    // setValue() on the JS thread, and mixing a native-driven snap on the same
    // value desyncs the two — the row lands mid-swipe and the next drag starts
    // from a stale position. Keeping both JS-driven keeps them consistent.
    Animated.spring(translateX, {
      toValue: to,
      useNativeDriver: false,
      bounciness: 0,
      speed: 18,
    }).start()
  }

  // React to the parent changing openSide (another row/side opened, or a scroll
  // closed everything) so this row's animation stays in sync with the model.
  useEffect(() => {
    const target = openSide === 'trailing' ? -trailingWidth : openSide === 'leading' ? leadingWidth : 0
    if (offset.current !== target) animateTo(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSide, trailingWidth, leadingWidth])

  const panResponder = useMemo(() => {
    // Settle to the nearest rest state from wherever the drag ended. Reads the
    // live translateX so it's correct on both a normal release and a forced
    // terminate.
    const settle = (vx: number) => {
      translateX.stopAnimation((current: number) => {
        if (leadingAction && (current > leadingWidth / 2 || vx > 0.3)) {
          animateTo(leadingWidth)
          onOpenSide('leading')
        } else if (current < -trailingWidth / 3 || vx < -0.3) {
          animateTo(-trailingWidth)
          onOpenSide('trailing')
        } else {
          animateTo(0)
          onOpenSide(null)
        }
      })
    }
    return PanResponder.create({
      // Capture the horizontal swipe before the inner Pressable/row can treat it
      // as a tap. Vertical drags fail this test and bubble to the FlatList scroll.
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > CLAIM_THRESHOLD,
      onPanResponderMove: (_e, g) => {
        const next = Math.max(-trailingWidth, Math.min(leadingWidth, offset.current + g.dx))
        translateX.setValue(next)
      },
      onPanResponderRelease: (_e, g) => settle(g.vx),
      onPanResponderTerminate: (_e, g) => settle(g.vx),
      // Once we own the swipe, don't hand it back to the FlatList mid-drag —
      // that was snapping the row shut the instant a swipe began.
      onPanResponderTerminationRequest: () => false,
    })
    // Widths are stable for a given action set; handlers read live refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailingWidth, leadingWidth])

  // One slab renderer shared by both swipe directions, so the leading (pin) and
  // trailing (mute/settings/delete) actions are visually identical — a tap
  // closes the row, then runs the action.
  const renderSlab = (action: SwipeAction) => (
    <Pressable
      key={action.key}
      style={[styles.slab, { width: SLAB_WIDTH, backgroundColor: action.color }]}
      onPress={() => {
        selectionHaptic()
        onOpenSide(null)
        action.onPress()
      }}
      accessibilityRole="button"
      accessibilityLabel={action.label}
    >
      {action.icon}
      <Text style={styles.slabLabel} numberOfLines={1}>{action.label}</Text>
    </Pressable>
  )

  const handleRowPress = () => {
    if (offset.current !== 0) {
      animateTo(0)
      onOpenSide(null)
      return
    }
    onPress()
  }

  return (
    <View style={styles.wrap}>
      {/* Leading (pin) slab — revealed on the left by a right-swipe, then tapped. */}
      {leadingAction ? (
        <View style={[styles.leading, { width: leadingWidth }]} pointerEvents={openSide === 'leading' ? 'auto' : 'none'}>
          {renderSlab(leadingAction)}
        </View>
      ) : null}

      {/* Trailing action slabs — revealed on the right by a left-swipe. */}
      <View style={[styles.trailing, { width: trailingWidth }]} pointerEvents={openSide === 'trailing' ? 'auto' : 'none'}>
        {actions.map(renderSlab)}
      </View>

      {/* Foreground row — opaque so the slabs stay hidden when closed. */}
      <Animated.View style={[styles.front, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
        <Pressable onPress={handleRowPress}>{children}</Pressable>
      </Animated.View>
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  const slab = {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 4,
  }
  return StyleSheet.create({
    wrap: { position: 'relative' },
    front: { backgroundColor: colors.bg },
    // Both panels are row containers so each slab's `alignSelf: 'stretch'` fills
    // the full row height (a column container would only stretch it horizontally).
    leading: { position: 'absolute', left: 0, top: 0, bottom: 0, flexDirection: 'row' },
    trailing: { position: 'absolute', right: 0, top: 0, bottom: 0, flexDirection: 'row' },
    slab: { top: 0, bottom: 0, alignSelf: 'stretch', ...slab },
    slabLabel: { color: '#ffffff', fontSize: typography.sizeXs, fontWeight: typography.weightMedium },
  })
}
