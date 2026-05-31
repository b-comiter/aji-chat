import { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import type { ThemeColors } from '../../../constants/theme'
import type { Item } from '../../../hooks/chatTypes'
import { formatJson, summarizeJson, toolIcon } from './toolSheetHelpers'
import { makeCardStyles } from './toolSheetStyles'

type ToolCardProps = {
  tool: Extract<Item, { kind: 'tool' }>
  startOpen: boolean
  colors: ThemeColors
}

export function ToolCard({ tool, startOpen, colors }: ToolCardProps) {
  const [open, setOpen] = useState(startOpen)
  const styles = useMemo(() => makeCardStyles(colors), [colors])
  const argsText = formatJson(tool.args)
  const resultText = tool.result !== undefined ? formatJson(tool.result) : null
  const statusTone = tool.done ? colors.success : colors.accent
  const statusLabel = tool.done ? 'Completed' : 'Running'
  const previewLabel = tool.done && resultText !== null ? 'Result' : 'Args'
  const previewText = tool.done
    ? resultText !== null
      ? summarizeJson(tool.result)
      : 'Completed with no result payload'
    : summarizeJson(tool.args)

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.cardHead}
        onPress={() => setOpen((v) => !v)}
        hitSlop={4}
      >
        <Text style={[styles.chev, open && styles.chevOpen]}>▶</Text>
        <View style={styles.iconWrap}>
          <Text style={styles.icon}>{toolIcon(tool.name)}</Text>
        </View>
        <View style={styles.textBlock}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {tool.name}
            </Text>
          </View>
          {/* <Text style={styles.preview} numberOfLines={2}>
            <Text style={styles.previewLabel}>{previewLabel}: </Text>
            {previewText}
          </Text> */}
        </View>
      </Pressable>

      {open && (
        <View style={styles.detail}>
          <View style={styles.section}>
            <Text style={styles.detailLabel}>ARGS</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.codeScroll}
            >
              <Text style={styles.code} selectable>
                {argsText}
              </Text>
            </ScrollView>
          </View>

          {resultText !== null && (
            <View style={[styles.section, styles.sectionSpacing]}>
              <Text style={styles.detailLabel}>RESULT</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.codeScroll}
              >
                <Text style={styles.code} selectable>
                  {resultText}
                </Text>
              </ScrollView>
            </View>
          )}
        </View>
      )}
    </View>
  )
}
