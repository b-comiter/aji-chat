/**
 * Bottom sheet that displays all tool calls for a single agent message.
 * Opens when the user taps the "🔧 N tool calls" badge.
 */
import { useEffect, useMemo, useRef } from 'react'
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

  const openHeight = Math.round(screenHeight * 0.75)
  const expandedHeight = Math.round(screenHeight * 0.92)
  const minHeight = Math.round(screenHeight * 0.48)
  const dismissThreshold = Math.round(screenHeight * 0.32)

  const toolItems = tools.filter((it): it is ToolItem => it.kind === 'tool')
  const runningCount = toolItems.filter((tool) => !tool.done).length
  const completedCount = toolItems.length - runningCount

  useEffect(() => {
    if (visible) {
      sheetHeight.setValue(openHeight)
    }
  }, [visible, openHeight, sheetHeight])

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          Math.abs(gestureState.dy) > Math.abs(gestureState.dx) &&
          Math.abs(gestureState.dy) > 4,
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

          if (nextHeight <= dismissThreshold || gestureState.dy > 180) {
            Animated.timing(sheetHeight, {
              toValue: 0,
              duration: 160,
              useNativeDriver: false,
            }).start(() => onClose())
            return
          }

          const targetHeight =
            gestureState.dy < -80 ? expandedHeight : Math.max(minHeight, openHeight)

          Animated.spring(sheetHeight, {
            toValue: targetHeight,
            useNativeDriver: false,
            damping: 22,
            stiffness: 180,
            mass: 0.9,
          }).start()
        },
      }),
    [dismissThreshold, expandedHeight, minHeight, onClose, openHeight, sheetHeight],
  )

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: safeBottom + spacing.md, height: sheetHeight },
          ]}
        >
          <View style={styles.dragHandleArea} {...panResponder.panHandlers}>
            <View style={styles.grabber} />
            <Text style={styles.dragHint}>Drag to resize • pull down to close</Text>
          </View>

          <View style={styles.header}>
            <View style={styles.headerMain}>
              <Text style={styles.title}>Tool calls</Text>
              <Text style={styles.sub}>
                {toolItems.length} call{toolItems.length === 1 ? '' : 's'}
                {toolItems.some((t) => !t.done) ? ' · in progress' : ' · completed'}
              </Text>
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
            <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
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
                  startOpen={i === 0}
                  colors={colors}
                />
              ))
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  )
}
