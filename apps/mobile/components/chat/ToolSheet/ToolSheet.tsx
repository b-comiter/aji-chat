/**
 * Bottom sheet that displays all tool calls for a single agent message.
 * Opens when the user taps the "🔧 N tool calls" badge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing } from '../../../constants/theme'
import { useTheme } from '../../../context/ThemeContext'
import type { Item } from '../../../hooks/chatTypes'
import { ToolCard } from './ToolCard'
import { makeSheetStyles } from './toolSheetStyles'

type ToolItem = Extract<Item, { kind: 'tool' }>

const SHEET_OPEN_RATIO = 0.75
const SHEET_EXPANDED_RATIO = 0.92
const SHEET_MIN_RATIO = 0.48
const SHEET_DISMISS_RATIO = 0.32

const GESTURE_CAPTURE_DY = 4
const GESTURE_DISMISS_DY = 180
const GESTURE_EXPAND_DY = -80

const SHEET_CLOSE_DURATION_MS = 160
const SHEET_OPEN_SPRING_CONFIG = {
  damping: 24,
  stiffness: 210,
  mass: 0.92,
} as const
const SHEET_SPRING_CONFIG = {
  damping: 22,
  stiffness: 180,
  mass: 0.9,
} as const

type Props = {
  tools: Item[]
  visible: boolean
  onClose: () => void
}

export function ToolSheet({ tools, visible, onClose }: Props) {
  const { colors } = useTheme()
  const { bottom: safeBottom } = useSafeAreaInsets()
  const { height: screenHeight } = useWindowDimensions()
  const styles = useMemo(() => makeSheetStyles(colors), [colors])
  const sheetHeight = useRef(new Animated.Value(0)).current
  const startHeight = useRef(0)
  const [collapseSignal, setCollapseSignal] = useState(0)
  const [openToolIds, setOpenToolIds] = useState<Set<string>>(new Set())

  const openHeight = Math.round(screenHeight * SHEET_OPEN_RATIO)
  const expandedHeight = Math.round(screenHeight * SHEET_EXPANDED_RATIO)
  const minHeight = Math.round(screenHeight * SHEET_MIN_RATIO)
  const dismissThreshold = Math.round(screenHeight * SHEET_DISMISS_RATIO)

  const toolItems = useMemo(
    () => tools.filter((it): it is ToolItem => it.kind === 'tool'),
    [tools],
  )
  const runningCount = useMemo(
    () => toolItems.filter((tool) => !tool.done).length,
    [toolItems],
  )
  const completedCount = toolItems.length - runningCount

  const animateClose = useCallback(() => {
    Animated.timing(sheetHeight, {
      toValue: 0,
      duration: SHEET_CLOSE_DURATION_MS,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) onClose()
    })
  }, [onClose, sheetHeight])

  useEffect(() => {
    if (visible) {
      sheetHeight.stopAnimation((value) => {
        const startValue = value > 0 ? value : 0
        sheetHeight.setValue(startValue)
        Animated.spring(sheetHeight, {
          toValue: openHeight,
          useNativeDriver: false,
          ...SHEET_OPEN_SPRING_CONFIG,
        }).start()
      })
      const singleToolId = toolItems.length === 1 ? toolItems[0]?.id : undefined
      setOpenToolIds(singleToolId ? new Set([singleToolId]) : new Set())
    } else {
      sheetHeight.setValue(0)
      setOpenToolIds(new Set())
    }
  }, [visible, openHeight, sheetHeight])

  const hasOpenTools = openToolIds.size > 0

  const handleOpenChange = useCallback((toolId: string, isOpen: boolean) => {
    setOpenToolIds((prev) => {
      const alreadyOpen = prev.has(toolId)
      if (isOpen === alreadyOpen) return prev

      const next = new Set(prev)
      if (isOpen) {
        next.add(toolId)
      } else {
        next.delete(toolId)
      }
      return next
    })
  }, [])

  const handleCollapseAll = useCallback(() => {
    if (!hasOpenTools) return
    setCollapseSignal((v) => v + 1)
    setOpenToolIds(new Set())
  }, [hasOpenTools])

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          Math.abs(gestureState.dy) > Math.abs(gestureState.dx) &&
          Math.abs(gestureState.dy) > GESTURE_CAPTURE_DY,
        onPanResponderGrant: () => {
          sheetHeight.stopAnimation((value) => {
            startHeight.current = value
          })
        },
        onPanResponderMove: (_, gestureState) => {
          const nextHeight = Math.max(
            0,
            Math.min(expandedHeight, startHeight.current - gestureState.dy),
          )
          sheetHeight.setValue(nextHeight)
        },
        onPanResponderRelease: (_, gestureState) => {
          const currentHeight = startHeight.current - gestureState.dy
          const nextHeight = Math.max(0, Math.min(expandedHeight, currentHeight))

          if (nextHeight <= dismissThreshold || gestureState.dy > GESTURE_DISMISS_DY) {
            animateClose()
            return
          }

          const targetHeight =
            gestureState.dy < GESTURE_EXPAND_DY ? expandedHeight : Math.max(minHeight, openHeight)

          Animated.spring(sheetHeight, {
            toValue: targetHeight,
            useNativeDriver: false,
            ...SHEET_SPRING_CONFIG,
          }).start()
        },
      }),
    [animateClose, dismissThreshold, expandedHeight, minHeight, openHeight, sheetHeight],
  )

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={animateClose}
    >
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={animateClose} />

        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: safeBottom + spacing.md, height: sheetHeight },
          ]}
        >
          <View style={styles.dragHandleArea} {...panResponder.panHandlers}>
            <View style={styles.grabber} />
          </View>

          <View style={styles.header}>
            <View style={styles.headerMain}>
              <Text style={styles.title}>Tool calls</Text>
              <Text style={styles.sub}>
                {toolItems.length} call{toolItems.length === 1 ? '' : 's'}
                {toolItems.some((t) => !t.done) ? ' · in progress' : ' · completed'}
              </Text>
                            {hasOpenTools && (
                <Pressable style={styles.collapseAllBtn} onPress={handleCollapseAll} hitSlop={8}>
                  <Text style={styles.collapseAllBtnText}>Collapse all</Text>
                </Pressable>
              )}
              <View style={styles.summaryRow}>
                <View style={styles.summaryChip}>
                  <Text style={styles.summaryChipText}>{toolItems.length} total</Text>
                </View>
                <View style={styles.summaryChip}>
                  <Text style={styles.summaryChipText}>{completedCount} completed</Text>
                </View>
                <View style={styles.summaryChip}>
                  <Text style={styles.summaryChipText}>{runningCount} running</Text>
                </View>
              </View>
            </View>
            <Pressable onPress={animateClose} style={styles.closeBtn} hitSlop={8}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator={false}
          >
            {toolItems.length === 0 ? (
              <Text style={styles.empty}>No tool calls to display.</Text>
            ) : (
              toolItems.map((tool, i) => (
                <ToolCard
                  key={tool.id}
                  tool={tool}
                  startOpen={toolItems.length === 1 && i === 0}
                  colors={colors}
                  collapseSignal={collapseSignal}
                  onOpenChange={handleOpenChange}
                />
              ))
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  )
}
