import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing, typography } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { useTheme } from '../../context/ThemeContext'
import { hexToRgba } from './colorUtils'

// Table layout constants. Columns are a fixed, readable width so cells never
// crush to one-word-per-line regardless of column count; the inline preview just
// shows as many as fit and fades the rest.
const TABLE_COL_WIDTH = 140
const PREVIEW_ROWS = 16

type Cells = ReactNode[][]
type Rows = ReactNode[][][]
type RowOpts = { header?: boolean; zebra?: boolean }

// Soft right-edge fade signalling horizontal overflow. expo-linear-gradient
// isn't installed (and adding a native module would force a dev-client rebuild),
// so this approximates a gradient with a few stepped solid bands — flat fills,
// no flashing during streaming.
function EdgeFade({ color }: { color: string }) {
  return (
    <View pointerEvents="none" style={edgeFadeStyle.wrap}>
      {[0, 0.15, 0.35, 0.58, 0.8, 1].map((a, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: hexToRgba(color, a) }} />
      ))}
    </View>
  )
}

const edgeFadeStyle = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, bottom: 0, right: 0, width: 36, flexDirection: 'row' },
})

// ---------------------------------------------------------------------------
// MarkdownTable — compact inline grid preview that opens a full-screen viewer.
//
// Inline, the grid is clipped (cells are single-line, rows capped at
// PREVIEW_ROWS) with NO horizontal ScrollView — a horizontal ScrollView fills
// its cross-axis and balloons inside the chat's inverted FlatList. When the
// table is wider than the bubble, fixed-width columns overflow and clip, and a
// fade marks the cut edge. When it fits, columns stretch to fill and there's no
// fade. Tap anywhere to open the viewer, which scrolls a real grid both axes.
// ---------------------------------------------------------------------------
export function MarkdownTable({ header, rows }: { header: Cells; rows: Rows }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeTableStyles(colors), [colors])
  const [expanded, setExpanded] = useState(false)
  const [containerW, setContainerW] = useState(0)

  const numCols = header.length
  const numRows = rows.length
  const contentW = numCols * TABLE_COL_WIDTH
  const fits = containerW > 0 && contentW <= containerW
  const overflows = containerW > 0 && contentW > containerW
  const previewRows = numRows > PREVIEW_ROWS ? rows.slice(0, PREVIEW_ROWS) : rows

  const cellStyle = fits ? styles.cellFill : styles.cellFixed

  const renderRow = (cells: Cells, key: string, opts: RowOpts) => (
    <View
      key={key}
      style={[styles.row, opts.header ? styles.headerRow : styles.rowBorder, opts.zebra && styles.zebraRow]}
    >
      {cells.map((cell, i) => (
        <View key={i} style={[cellStyle, i < cells.length - 1 && styles.cellBorder]}>
          <Text numberOfLines={1} style={styles.cellText}>{cell.length ? cell : ' '}</Text>
        </View>
      ))}
    </View>
  )

  return (
    <Pressable
      onPress={() => setExpanded(true)}
      style={styles.preview}
      accessibilityRole="button"
      accessibilityLabel={`Open table, ${numCols} column${numCols === 1 ? '' : 's'} by ${numRows} row${numRows === 1 ? '' : 's'}`}
    >
      <View style={styles.bar}>
        <Feather name="table" size={13} color={colors.textMuted} />
        <Text style={styles.dims}>{numCols} × {numRows}</Text>
        <Feather name="maximize-2" size={13} color={colors.textMuted} />
        <Text style={styles.expandText}>Expand</Text>
      </View>
      <View style={styles.clip} onLayout={(e) => setContainerW(e.nativeEvent.layout.width)}>
        <View>
          {renderRow(header, 'header', { header: true })}
          {previewRows.map((row, r) => renderRow(row, `r-${r}`, { zebra: r % 2 === 1 }))}
        </View>
        {overflows && <EdgeFade color={colors.surface} />}
      </View>
      {expanded && (
        <TableViewer header={header} rows={rows} colors={colors} onClose={() => setExpanded(false)} />
      )}
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// TableViewer — full-screen modal showing the whole grid. Scrolls vertically
// (rows) and horizontally (columns); cells wrap so nothing is clipped. A Modal
// renders above everything and is not inside the inverted FlatList, so the
// horizontal ScrollView is safe here.
// ---------------------------------------------------------------------------
function TableViewer({
  header,
  rows,
  colors,
  onClose,
}: {
  header: Cells
  rows: Rows
  colors: ThemeColors
  onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  const styles = useMemo(() => makeTableViewerStyles(colors), [colors])

  const renderRow = (cells: Cells, key: string, opts: RowOpts) => (
    <View
      key={key}
      style={[styles.row, opts.header ? styles.headerRow : styles.rowBorder, opts.zebra && styles.zebraRow]}
    >
      {cells.map((cell, i) => (
        <View key={i} style={[styles.cell, i < cells.length - 1 && styles.cellBorder]}>
          <Text style={styles.cellText}>{cell.length ? cell : ' '}</Text>
        </View>
      ))}
    </View>
  )

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Table</Text>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={styles.closeBtn}
          >
            <Feather name="x" size={24} color={colors.text} />
          </Pressable>
        </View>
        <ScrollView style={styles.vScroll} contentContainerStyle={styles.vContent}>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View style={styles.table}>
              {renderRow(header, 'header', { header: true })}
              {rows.map((row, r) => renderRow(row, `r-${r}`, { zebra: r % 2 === 1 }))}
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </Modal>
  )
}

function makeTableStyles(colors: ThemeColors) {
  return StyleSheet.create({
    preview: {
      marginVertical: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 8,
      overflow: 'hidden',
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: colors.surface2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    dims: { flex: 1, color: colors.textMuted, fontSize: typography.sizeSm, fontFamily: typography.fontMono },
    expandText: { color: colors.textMuted, fontSize: typography.sizeSm },
    clip: { overflow: 'hidden', backgroundColor: colors.surface },
    row: { flexDirection: 'row' },
    headerRow: { backgroundColor: colors.surface2 },
    zebraRow: { backgroundColor: colors.bg },
    rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    cellFill: { flex: 1, paddingHorizontal: 10, paddingVertical: 7 },
    cellFixed: { width: TABLE_COL_WIDTH, paddingHorizontal: 10, paddingVertical: 7 },
    cellBorder: { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
    cellText: { color: colors.text, fontSize: typography.sizeMd },
  })
}

function makeTableViewerStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    title: { flex: 1, color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold },
    closeBtn: { padding: spacing.xs },
    vScroll: { flex: 1 },
    vContent: { padding: spacing.lg },
    table: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 6,
      overflow: 'hidden',
    },
    row: { flexDirection: 'row' },
    headerRow: { backgroundColor: colors.surface2 },
    zebraRow: { backgroundColor: colors.surface },
    rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    cell: { width: TABLE_COL_WIDTH, paddingHorizontal: 10, paddingVertical: 8 },
    cellBorder: { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
    cellText: { color: colors.text, fontSize: typography.sizeMd },
  })
}
