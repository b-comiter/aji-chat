import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useMemo, useState, type ReactNode } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import { useDB } from '../db/DBProvider'
import { wipeAllHistory } from '../db/database'
import { useTheme, type ThemePreference, type PaletteFamily } from '../context/ThemeContext'
import { useWS } from '../context/WebSocketContext'
import { useAudioPlayerContext } from '../context/AudioPlayerContext'
import { MINI_PLAYER_BAR_HEIGHT } from '../components/audio/MiniPlayer'
import { spacing, typography, radius } from '../constants/theme'
import { SERVER_CONFIG } from '../constants/server'
import type { ThemeColors } from '../constants/theme'

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'auto',  label: 'Auto'  },
  { value: 'light', label: 'Light' },
  { value: 'dark',  label: 'Dark'  },
]

// Representative swatches (accent · bubble · surface) shown under each palette
// option so the difference is visible before selecting. Uses the dark-variant
// hexes since those are the most recognizable form of each palette.
const PALETTE_OPTIONS: { value: PaletteFamily; label: string; swatches: string[] }[] = [
  { value: 'aji',     label: 'Aji',     swatches: ['#E2C58E', '#D6B67A', '#182235'] },
  { value: 'classic', label: 'Classic', swatches: ['#5e8eff', '#b392f0', '#161b22'] },
]

// Light selection tick when toggling a setting. No-op where haptics are
// unavailable (web / unlinked dev clients) — mirrors the guard in MessageRow.
function safeHaptic() {
  try {
    Haptics.selectionAsync().catch(() => {})
  } catch {
    /* haptics unavailable — ignore */
  }
}

const BACK_ICON_SIZE = 28
const BACK_ICON_LINE_HEIGHT = 32
const SEGMENT_WRAPPER_PADDING = 3
const SEGMENT_GAP = 2
const SEGMENT_VERTICAL_PADDING = 5
const APP_CONFIG = require('../app.json') as { expo?: { version?: string } }
const EXPO_PACKAGE = require('expo/package.json') as { version?: string }

export default function SettingsScreen() {
  const db = useDB()
  const { colors, themePreference, setThemePreference, paletteFamily, setPaletteFamily } = useTheme()
  const { top: safeTop, bottom: safeBottom } = useSafeAreaInsets()
  const { activeTrack } = useAudioPlayerContext()
  const { conn } = useWS()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [isClearing, setIsClearing] = useState(false)
  // Push content below the floating mini-player when it's active (see AppHeader).
  const topPad = safeTop + (activeTrack ? MINI_PLAYER_BAR_HEIGHT : 0)

  const serverWs = SERVER_CONFIG.hostLabel
  const connColor =
    conn === 'connected' ? colors.success
    : conn === 'connecting' ? colors.warn
    : colors.danger
  const connLabel =
    conn === 'connected' ? 'Connected'
    : conn === 'connecting' ? 'Connecting'
    : 'Offline'
  const appVersion = APP_CONFIG.expo?.version ?? '1.0.0'
  const sdkVersion = EXPO_PACKAGE.version ?? 'Unknown'

  function handleClearAll() {
    Alert.alert(
      'Clear All History',
      'This will permanently delete all messages and agent history. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear Everything',
          style: 'destructive',
          onPress: async () => {
            if (isClearing) return
            setIsClearing(true)
            try {
              await wipeAllHistory(db)
              router.replace('/')
            } catch {
              Alert.alert('Failed to Clear History', 'Please try again in a moment.')
            } finally {
              setIsClearing(false)
            }
          },
        },
      ],
    )
  }

  return (
    <View style={[styles.screen, { paddingTop: topPad }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={8}
          accessibilityRole='button'
          accessibilityLabel='Go back'
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentContainer, { paddingBottom: safeBottom + spacing.lg }]}
      >
        <SettingsSection label='Appearance' styles={styles}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Theme</Text>
            <View style={styles.segmented} accessibilityRole='radiogroup' accessibilityLabel='Theme preference'>
              {THEME_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[styles.segment, themePreference === opt.value && styles.segmentActive]}
                  onPress={() => {
                    safeHaptic()
                    void setThemePreference(opt.value).catch(() => {
                      Alert.alert('Theme Update Failed', 'Could not save your theme preference.')
                    })
                  }}
                  accessibilityRole='radio'
                  accessibilityLabel={`Use ${opt.label} theme`}
                  accessibilityState={{ selected: themePreference === opt.value }}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      themePreference === opt.value && styles.segmentTextActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={[styles.row, styles.rowBorder]}>
            <Text style={styles.rowLabel}>Palette</Text>
            <View style={styles.segmented} accessibilityRole='radiogroup' accessibilityLabel='Color palette'>
              {PALETTE_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[styles.segment, styles.paletteSegment, paletteFamily === opt.value && styles.segmentActive]}
                  onPress={() => {
                    safeHaptic()
                    void setPaletteFamily(opt.value).catch(() => {
                      Alert.alert('Palette Update Failed', 'Could not save your palette preference.')
                    })
                  }}
                  accessibilityRole='radio'
                  accessibilityLabel={`Use ${opt.label} palette`}
                  accessibilityState={{ selected: paletteFamily === opt.value }}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      paletteFamily === opt.value && styles.segmentTextActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                  <View style={styles.swatchRow}>
                    {opt.swatches.map((c, i) => (
                      <View key={i} style={[styles.swatch, { backgroundColor: c }]} />
                    ))}
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        </SettingsSection>

        <SettingsSection label='Connection' styles={styles}>
          <View style={styles.row}>
            <View style={styles.connInfo}>
              <Text style={styles.connLabel}>Server</Text>
              <Text style={styles.connHost} numberOfLines={1}>{serverWs}</Text>
            </View>
            <View style={styles.connStatus}>
              <View style={[styles.connDot, { backgroundColor: connColor }]} />
              <Text style={[styles.connStatusText, { color: connColor }]}>{connLabel}</Text>
            </View>
          </View>
        </SettingsSection>

        <SettingsSection label='Data' styles={styles}>
          <Pressable
            style={[styles.destructiveRow, isClearing && styles.rowDisabled]}
            onPress={handleClearAll}
            disabled={isClearing}
            accessibilityRole='button'
            accessibilityLabel='Clear all history'
            accessibilityHint='Deletes all messages and agent history permanently'
            accessibilityState={{ disabled: isClearing }}
          >
            <Text style={styles.destructiveLabel}>{isClearing ? 'Clearing...' : 'Clear All History'}</Text>
          </Pressable>
        </SettingsSection>

        <SettingsSection label='About' styles={styles}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Version</Text>
            <Text style={styles.rowValue}>{appVersion}</Text>
          </View>
          <View style={[styles.row, styles.rowBorder]}>
            <Text style={styles.rowLabel}>SDK</Text>
            <Text style={styles.rowValue}>{sdkVersion}</Text>
          </View>
        </SettingsSection>
      </ScrollView>
    </View>
  )
}

function SettingsSection({
  label,
  styles,
  children,
}: {
  label: string
  styles: ReturnType<typeof makeStyles>
  children: ReactNode
}) {
  return (
    <>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.card}>{children}</View>
    </>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    content: {
      flex: 1,
    },
    contentContainer: {
      paddingTop: spacing.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.sm,
    },
    backBtn: {
      paddingRight: spacing.xs,
    },
    backText: {
      color: colors.accent,
      fontSize: BACK_ICON_SIZE,
      lineHeight: BACK_ICON_LINE_HEIGHT,
    },
    title: {
      color: colors.text,
      fontSize: typography.sizeXl,
      fontWeight: typography.weightSemibold,
      flex: 1,
    },
    sectionLabel: {
      color: colors.textDim,
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.xl,
      paddingBottom: spacing.sm,
    },
    card: {
      backgroundColor: colors.surface,
      marginHorizontal: spacing.lg,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    rowBorder: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    rowLabel: {
      color: colors.text,
      fontSize: typography.sizeLg,
      // Grow to push the trailing value/control to the right, but never shrink
      // below the label's own width — otherwise a long unbreakable value (e.g.
      // a server host) collapses this column and wraps the label mid-word.
      flexGrow: 1,
      flexShrink: 0,
      marginRight: spacing.md,
    },
    rowValue: {
      color: colors.textMuted,
      fontSize: typography.sizeLg,
      flexShrink: 1,
      textAlign: 'right',
    },
    // Segmented control for theme selection
    segmented: {
      flexDirection: 'row',
      backgroundColor: colors.surface2,
      borderRadius: radius.md,
      padding: SEGMENT_WRAPPER_PADDING,
      gap: SEGMENT_GAP,
    },
    segment: {
      paddingHorizontal: spacing.md,
      paddingVertical: SEGMENT_VERTICAL_PADDING,
      borderRadius: radius.sm,
    },
    paletteSegment: {
      alignItems: 'center',
      gap: 4,
    },
    segmentActive: {
      backgroundColor: colors.accent,
    },
    segmentText: {
      color: colors.textMuted,
      fontSize: typography.sizeMd,
      fontWeight: typography.weightMedium,
    },
    segmentTextActive: {
      color: colors.textOnAccent,
      fontWeight: typography.weightSemibold,
    },
    // Palette preview swatches
    swatchRow: {
      flexDirection: 'row',
      gap: 3,
    },
    swatch: {
      width: 8,
      height: 8,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(0,0,0,0.18)',
    },
    // Connection row — stacked label + host, with a status indicator
    connInfo: {
      flex: 1,
      marginRight: spacing.md,
    },
    connLabel: {
      color: colors.text,
      fontSize: typography.sizeLg,
    },
    connHost: {
      color: colors.textMuted,
      fontSize: typography.sizeMd,
      marginTop: 2,
    },
    connStatus: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexShrink: 0,
    },
    connDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    connStatusText: {
      fontSize: typography.sizeSm,
      fontWeight: typography.weightMedium,
    },
    destructiveRow: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    rowDisabled: {
      opacity: 0.65,
    },
    destructiveLabel: {
      color: colors.danger,
      fontSize: typography.sizeLg,
      fontWeight: typography.weightSemibold,
    },
  })
}
