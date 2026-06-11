/**
 * DraggableList — a long-press-to-reorder vertical list built on core React
 * Native primitives (PanResponder + Animated). No gesture-handler / reanimated
 * dependency, so it runs in the current dev client with no native rebuild.
 *
 * Interaction:
 *  - Tap a row            → onPressItem (normal navigation)
 *  - Long-press a row     → the row "lifts" (scale + shadow) and enters drag mode
 *  - Drag up/down         → neighbours slide out of the way in real time
 *  - Release              → order commits; onReorder fires if it changed
 *
 * Rows are absolutely positioned at `index * rowHeight`, so the list is NOT
 * virtualized and does NOT scroll — intentional for short lists (a server has a
 * handful of channels). For long, scrollable lists a future version should move
 * to react-native-gesture-handler + a draggable FlatList with autoscroll.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Animated, PanResponder, StyleSheet, View } from 'react-native'
import type { ViewStyle } from 'react-native'
import * as Haptics from 'expo-haptics'

const LONG_PRESS_MS = 220
const MOVE_CANCEL_PX = 8 // finger travel before the long-press fires cancels it
const LIFT_SCALE = 1.04

// Haptics degrade to a no-op on web and on dev clients built before
// expo-haptics was linked (the native module call throws/rejects there).
function safeHaptic(run: () => Promise<unknown>) {
  try {
    run().catch(() => {})
  } catch {
    /* native module unavailable */
  }
}
const hapticLift = () => safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium))
const hapticTick = () => safeHaptic(() => Haptics.selectionAsync())
const hapticDrop = () => safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

export function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((k, i) => k === b[i])
}

/**
 * Move `key` to `targetIndex` within `order`, returning a new array. Pure — the
 * drag gesture calls this on every slot crossing. A no-op (key absent or already
 * at the target) returns an equivalent ordering.
 */
export function moveKey(order: string[], key: string, targetIndex: number): string[] {
  const from = order.indexOf(key)
  if (from < 0) return order.slice()
  const arr = order.slice()
  arr.splice(from, 1)
  arr.splice(clamp(targetIndex, 0, arr.length), 0, key)
  return arr
}

export type DraggableListProps<T> = {
  data: T[]
  keyExtractor: (item: T) => string
  rowHeight: number
  renderItem: (item: T, opts: { isActive: boolean }) => ReactNode
  onPressItem: (item: T) => void
  onReorder: (orderedKeys: string[]) => void
  /** Background painted behind a lifted row so it reads as opaque over neighbours. */
  liftBackground?: string
  contentStyle?: ViewStyle
}

export function DraggableList<T>({
  data,
  keyExtractor,
  rowHeight,
  renderItem,
  onPressItem,
  onReorder,
  liftBackground,
  contentStyle,
}: DraggableListProps<T>) {
  const propsKeys = useMemo(() => data.map(keyExtractor), [data, keyExtractor])
  const itemByKey = useMemo(() => {
    const m = new Map<string, T>()
    for (const it of data) m.set(keyExtractor(it), it)
    return m
  }, [data, keyExtractor])

  const [orderKeys, setOrderKeys] = useState<string[]>(propsKeys)
  const [activeKey, setActiveKey] = useState<string | null>(null)

  // Latest props/callbacks for the long-lived PanResponder closures to read.
  const live = useRef({ itemByKey, onPressItem, onReorder })
  live.current = { itemByKey, onPressItem, onReorder }

  // Mutable drag state the responder callbacks read/write synchronously.
  const orderRef = useRef<string[]>(propsKeys)
  const activeKeyRef = useRef<string | null>(null)
  const currentIndexRef = useRef(0)
  const activeBaseRef = useRef(0)
  const startOrderRef = useRef<string[]>([])
  const movedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Per-key translateY values + one shared lift value for the active row.
  const translateMap = useRef(new Map<string, Animated.Value>()).current
  const lift = useRef(new Animated.Value(0)).current

  const getTranslate = (key: string, index: number): Animated.Value => {
    let v = translateMap.get(key)
    if (!v) {
      v = new Animated.Value(index * rowHeight)
      translateMap.set(key, v)
    }
    return v
  }

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // Sync from props when idle. Live refreshes (new/removed channels, status &
  // preview updates) land here; mid-drag we ignore props so the gesture holds.
  useEffect(() => {
    if (activeKeyRef.current) return
    orderRef.current = propsKeys
    setOrderKeys(propsKeys)
    propsKeys.forEach((k, i) => getTranslate(k, i).setValue(i * rowHeight))
    for (const k of Array.from(translateMap.keys())) {
      if (!propsKeys.includes(k)) translateMap.delete(k)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propsKeys, rowHeight])

  const activate = (key: string) => {
    const idx = orderRef.current.indexOf(key)
    if (idx < 0) return
    startOrderRef.current = orderRef.current.slice()
    currentIndexRef.current = idx
    activeBaseRef.current = idx * rowHeight
    activeKeyRef.current = key
    setActiveKey(key)
    hapticLift()
    Animated.spring(lift, { toValue: 1, useNativeDriver: true, friction: 8 }).start()
  }

  const settleOthers = (activeK: string) => {
    orderRef.current.forEach((k, i) => {
      if (k === activeK) return
      Animated.spring(getTranslate(k, i), {
        toValue: i * rowHeight,
        useNativeDriver: true,
        friction: 14,
        tension: 130,
      }).start()
    })
  }

  const moveActive = (key: string, target: number) => {
    orderRef.current = moveKey(orderRef.current, key, target)
    currentIndexRef.current = target
    hapticTick()
    settleOthers(key)
  }

  const drop = (key: string) => {
    const finalIndex = orderRef.current.indexOf(key)
    Animated.spring(getTranslate(key, finalIndex), {
      toValue: finalIndex * rowHeight,
      useNativeDriver: true,
      friction: 14,
      tension: 130,
    }).start()
    Animated.spring(lift, { toValue: 0, useNativeDriver: true, friction: 8 }).start()
    hapticDrop()
    activeKeyRef.current = null
    setActiveKey(null)
    const newOrder = orderRef.current.slice()
    setOrderKeys(newOrder)
    if (!sameOrder(newOrder, startOrderRef.current)) {
      live.current.onReorder(newOrder)
    }
  }

  // One memoized PanResponder per key; closures read refs so they stay current.
  const handlersRef = useRef(new Map<string, ReturnType<typeof makeHandlers>>()).current

  function makeHandlers(key: string) {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => activeKeyRef.current !== key,
      onPanResponderGrant: () => {
        movedRef.current = false
        clearTimer()
        timerRef.current = setTimeout(() => activate(key), LONG_PRESS_MS)
      },
      onPanResponderMove: (_e, g) => {
        if (activeKeyRef.current === key) {
          const newY = activeBaseRef.current + g.dy
          getTranslate(key, currentIndexRef.current).setValue(newY)
          const target = clamp(Math.round(newY / rowHeight), 0, orderRef.current.length - 1)
          if (target !== currentIndexRef.current) moveActive(key, target)
        } else if (!movedRef.current && Math.hypot(g.dx, g.dy) > MOVE_CANCEL_PX) {
          movedRef.current = true
          clearTimer() // moved before the long-press armed → not a tap, not a drag
        }
      },
      onPanResponderRelease: (_e, g) => {
        clearTimer()
        if (activeKeyRef.current === key) {
          drop(key)
        } else if (!movedRef.current && Math.hypot(g.dx, g.dy) <= MOVE_CANCEL_PX) {
          const item = live.current.itemByKey.get(key)
          if (item) live.current.onPressItem(item)
        }
      },
      onPanResponderTerminate: () => {
        clearTimer()
        if (activeKeyRef.current === key) drop(key)
      },
    })
  }

  const getHandlers = (key: string) => {
    let h = handlersRef.get(key)
    if (!h) {
      h = makeHandlers(key)
      handlersRef.set(key, h)
    }
    return h.panHandlers
  }

  // Drop handlers for keys that no longer exist.
  useEffect(() => {
    for (const k of Array.from(handlersRef.keys())) {
      if (!propsKeys.includes(k)) handlersRef.delete(k)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propsKeys])

  useEffect(() => clearTimer, [])

  return (
    <View style={[styles.container, { height: orderKeys.length * rowHeight }, contentStyle]}>
      {orderKeys.map((key, index) => {
        const item = itemByKey.get(key)
        if (!item) return null
        const isActive = key === activeKey
        const translateY = getTranslate(key, index)
        const scale = isActive
          ? lift.interpolate({ inputRange: [0, 1], outputRange: [1, LIFT_SCALE] })
          : 1
        return (
          <Animated.View
            key={key}
            {...getHandlers(key)}
            style={[
              styles.row,
              { height: rowHeight, transform: [{ translateY }, { scale }] },
              isActive && styles.activeRow,
              isActive && liftBackground ? { backgroundColor: liftBackground } : null,
            ]}
          >
            {renderItem(item, { isActive })}
          </Animated.View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { position: 'relative', width: '100%' },
  row: { position: 'absolute', left: 0, right: 0, top: 0 },
  activeRow: {
    zIndex: 20,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
})
