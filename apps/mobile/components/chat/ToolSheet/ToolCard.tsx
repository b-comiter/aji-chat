import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, Pressable, ScrollView, Text, View } from 'react-native'
import type { StyleProp, ViewStyle } from 'react-native'
import hljs from 'highlight.js'
import type { ThemeColors } from '../../../constants/theme'
import { useTheme } from '../../../context/ThemeContext'
import type { Item } from '../../../hooks/chatTypes'
import { formatJson, getToolPreview, toolIcon } from './toolSheetHelpers'
import { makeCardStyles } from './toolSheetStyles'

type ToolCardProps = {
  tool: Extract<Item, { kind: 'tool' }>
  startOpen: boolean
  colors: ThemeColors
  collapseSignal: number
  onOpenChange?: (toolId: string, isOpen: boolean) => void
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
}

function highlightJson(
  code: string,
  colors: ThemeColors,
  tokenColors: Record<string, string>,
): Array<string | JSX.Element> {
  try {
    const { value: html } = hljs.highlight(code, { language: 'json', ignoreIllegals: true })
    const elements: Array<string | JSX.Element> = []
    const stack: Array<{ color: string; token?: string }> = [{ color: colors.text }]

    let i = 0
    while (i < html.length) {
      if (html[i] === '<') {
        const end = html.indexOf('>', i)
        if (end === -1) break
        const tag = html.slice(i, end + 1)

        if (tag.startsWith('<span')) {
          const classMatch = tag.match(/class="([^"]+)"/)
          if (classMatch) {
            const tokenType = classMatch[1].split(' ')[0].replace('hljs-', '')
            stack.push({ color: tokenColors[tokenType] ?? colors.text, token: tokenType })
          } else {
            stack.push({ ...stack[stack.length - 1] })
          }
        } else if (tag === '</span>') {
          if (stack.length > 1) stack.pop()
        }

        i = end + 1
        continue
      }

      const nextTag = html.indexOf('<', i)
      const chunk = nextTag === -1 ? html.slice(i) : html.slice(i, nextTag)
      if (chunk) {
        const text = decodeHtmlEntities(chunk)
        const top = stack[stack.length - 1]

        if (top.color === colors.text) {
          elements.push(text)
        } else {
          elements.push(
            <Text key={`tok-${i}`} style={{ color: top.color }}>
              {text}
            </Text>,
          )
        }
      }
      i = nextTag === -1 ? html.length : nextTag
    }

    return elements.length > 0 ? elements : [code]
  } catch {
    return [code]
  }
}

function ToolCardInner({ tool, startOpen, colors, collapseSignal, onOpenChange }: ToolCardProps) {
  const [open, setOpen] = useState(startOpen)
  const [renderDetail, setRenderDetail] = useState(startOpen)
  const [detailContentHeight, setDetailContentHeight] = useState(0)
  const didMountCollapseEffect = useRef(false)
  const didMountOpenReportEffect = useRef(false)
  const pendingOpenAnimation = useRef(false)
  const detailProgress = useRef(new Animated.Value(startOpen ? 1 : 0)).current
  const { tokenColors } = useTheme()
  const styles = useMemo(() => makeCardStyles(colors), [colors])
  const preview = useMemo(
    () => getToolPreview(tool.name, tool.args, tool.result, tool.done),
    [tool.name, tool.args, tool.result, tool.done],
  )

  const shouldRenderDetailContent = renderDetail

  const runOpenAnimation = () => {
    Animated.timing(detailProgress, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }

  const detailAnimatedStyle = useMemo(
    () => ({
      height: detailProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, Math.max(1, detailContentHeight)],
      }),
      opacity: detailProgress,
      transform: [
        {
          translateY: detailProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [-8, 0],
          }),
        },
      ],
    }),
    [detailContentHeight, detailProgress],
  )

  const chevronAnimatedStyle = useMemo(
    () => ({
      transform: [
        {
          rotate: detailProgress.interpolate({
            inputRange: [0, 1],
            outputRange: ['0deg', '90deg'],
          }),
        },
      ],
    }),
    [detailProgress],
  )

  // Expensive pretty-printing/highlighting is deferred until card expansion.
  const argsText = useMemo(
    () => (shouldRenderDetailContent ? formatJson(tool.args) : ''),
    [shouldRenderDetailContent, tool.args],
  )
  const resultText = useMemo(
    () => (shouldRenderDetailContent && tool.result !== undefined ? formatJson(tool.result) : null),
    [shouldRenderDetailContent, tool.result],
  )

  const argsHighlighted = useMemo(
    () => (shouldRenderDetailContent ? highlightJson(argsText, colors, tokenColors) : []),
    [shouldRenderDetailContent, argsText, colors, tokenColors],
  )
  const resultHighlighted = useMemo(
    () =>
      shouldRenderDetailContent && resultText !== null
        ? highlightJson(resultText, colors, tokenColors)
        : null,
    [shouldRenderDetailContent, resultText, colors, tokenColors],
  )

  const setOpenAnimated = (next: boolean | ((prev: boolean) => boolean)) => {
    setOpen((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next
      if (resolved === prev) return prev

      detailProgress.stopAnimation()
      if (resolved) {
        setRenderDetail(true)
        detailProgress.setValue(0)
        if (detailContentHeight > 0) {
          pendingOpenAnimation.current = false
          runOpenAnimation()
        } else {
          pendingOpenAnimation.current = true
        }
      } else {
        pendingOpenAnimation.current = false
        Animated.timing(detailProgress, {
          toValue: 0,
          duration: 150,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: false,
        }).start(({ finished }) => {
          if (finished) setRenderDetail(false)
        })
      }

      return resolved
    })
  }

  useEffect(() => {
    setOpenAnimated(startOpen)
  }, [startOpen])

  useEffect(() => {
    if (!didMountCollapseEffect.current) {
      didMountCollapseEffect.current = true
      return
    }
    setOpenAnimated(false)
  }, [collapseSignal])

  useEffect(() => {
    if (!didMountOpenReportEffect.current) {
      didMountOpenReportEffect.current = true
      return
    }
    onOpenChange?.(tool.id, open)
  }, [open, onOpenChange, tool.id])

  const renderCodeBlock = (
    content: string,
    highlighted: Array<string | JSX.Element>,
    containerStyle?: StyleProp<ViewStyle>,
  ) => (
    <View style={[styles.codeShell, containerStyle]}>
      <ScrollView
        style={styles.codeScrollY}
        contentContainerStyle={styles.codeScrollYContent}
        showsVerticalScrollIndicator
        nestedScrollEnabled
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          style={styles.codeScrollX}
          contentContainerStyle={styles.codeScrollXContent}
          nestedScrollEnabled
        >
          <View style={styles.codeInner}>
            <Text style={styles.code} selectable>
              {highlighted.length > 0 ? highlighted : content}
            </Text>
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  )

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.cardHead}
        onPress={() => setOpenAnimated((v) => !v)}
        hitSlop={4}
      >
        <Animated.Text style={[styles.chev, chevronAnimatedStyle]}>▶</Animated.Text>
        <View style={styles.iconWrap}>
          <Text style={styles.icon}>{toolIcon(tool.name)}</Text>
        </View>
        <View style={styles.textBlock}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {tool.name}
            </Text>
          </View>
          <Text style={styles.preview} numberOfLines={2}>
            <Text style={styles.previewLabel}>{preview.label}: </Text>
            {preview.text}
          </Text>
        </View>
      </Pressable>

      {renderDetail && (
        <Animated.View style={[styles.detailAnimatedWrap, detailAnimatedStyle]}>
          <View
            style={styles.detail}
            onLayout={(event) => {
              const next = Math.ceil(event.nativeEvent.layout.height)
              setDetailContentHeight((prev) => {
                if (Math.abs(prev - next) <= 1) return prev
                return next
              })

              if (pendingOpenAnimation.current && next > 0) {
                pendingOpenAnimation.current = false
                runOpenAnimation()
              }
            }}
          >
            <View style={styles.section}>
              <Text style={styles.detailLabel}>ARGS</Text>
              {renderCodeBlock(argsText, argsHighlighted, styles.codeScrollContent)}
            </View>

            {resultText !== null && (
              <View style={[styles.section, styles.sectionSpacing]}>
                <Text style={styles.detailLabel}>RESULT</Text>
                {renderCodeBlock(resultText, resultHighlighted ?? [resultText], styles.codeScrollContent)}
              </View>
            )}
          </View>
        </Animated.View>
      )}
    </View>
  )
}

export const ToolCard = memo(ToolCardInner)
