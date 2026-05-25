import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import Constants from 'expo-constants'
import { useMemo } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDB } from '../db/DBProvider'
import { wipeAllHistory } from '../db/database'
import { useTheme, type ThemePreference } from '../context/ThemeContext'
import { spacing, typography, radius } from '../constants/theme'
import type { ThemeColors } from '../constants/theme'

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'auto',  label: 'Auto'  },
  { value: 'light', label: 'Light' },
  { value: 'dark',  label: 'Dark'  },
]

export default function SettingsScreen() {
  const db = useDB()
  const { colors, themePreference, setThemePreference } = useTheme()
  const { top: safeTop, bottom: safeBottom } = useSafeAreaInsets()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const serverHost = process.env.EXPO_PUBLIC_SERVER_HOST ?? 'not set'
  const serverWs = `ws://${serverHost}:4000`
  const appVersion = Constants.expoConfig?.version ?? '1.0.0'

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
            await wipeAllHistory(db)
            router.replace('/')
          },
        },
      ],
    )
  }

  return (
    <View style={[styles.screen, { paddingTop: safeTop, paddingBottom: safeBottom }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>

      {/* ── Appearance ── */}
      <Text style={styles.sectionLabel}>Appearance</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Theme</Text>
          <View style={styles.segmented}>
            {THEME_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                style={[styles.segment, themePreference === opt.value && styles.segmentActive]}
                onPress={() => setThemePreference(opt.value)}
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
      </View>

      {/* ── Connection ── */}
      <Text style={styles.sectionLabel}>Connection</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Server</Text>
          <Text style={styles.rowValue} numberOfLines={1}>{serverWs}</Text>
        </View>
      </View>

      {/* ── Data ── */}
      <Text style={styles.sectionLabel}>Data</Text>
      <View style={styles.card}>
        <Pressable style={styles.destructiveRow} onPress={handleClearAll}>
          <Text style={styles.destructiveLabel}>Clear All History</Text>
        </Pressable>
      </View>

      {/* ── About ── */}
      <Text style={styles.sectionLabel}>About</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Version</Text>
          <Text style={styles.rowValue}>{appVersion}</Text>
        </View>
        <View style={[styles.row, styles.rowBorder]}>
          <Text style={styles.rowLabel}>SDK</Text>
          <Text style={styles.rowValue}>Expo 54</Text>
        </View>
      </View>
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.bg,
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
      fontSize: 28,
      lineHeight: 32,
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
      flex: 1,
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
      padding: 3,
      gap: 2,
    },
    segment: {
      paddingHorizontal: spacing.md,
      paddingVertical: 5,
      borderRadius: radius.sm,
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
      color: '#fff',
      fontWeight: typography.weightSemibold,
    },
    destructiveRow: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    destructiveLabel: {
      color: colors.danger,
      fontSize: typography.sizeLg,
      fontWeight: typography.weightSemibold,
    },
  })
}
