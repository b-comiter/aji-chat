/**
 * Per-server settings — avatar, mono-channel behavior, and display name.
 *
 * Reuses the section/card styling from the global settings screen. The avatar
 * can be a picked photo (stored inline as a data: URI) or a preset emoji. The
 * mono-channel control is a three-way: "Default" defers to whatever the agent
 * advertised (shown as a hint), while "Single"/"Multiple" are explicit local
 * overrides. Effective behavior = override ?? advertised ?? multi.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as ImagePicker from 'expo-image-picker'
import { useDB } from '../../../db/DBProvider'
import { useTheme } from '../../../context/ThemeContext'
import { ServerAvatar, AVATAR_PRESETS } from '../../../components/ServerAvatar'
import {
  getServer,
  serverDisplayName,
  setServerAvatar,
  setServerMonoOverride,
  renameServer,
  type ServerRow,
} from '../../../db/database'
import { spacing, typography, radius } from '../../../constants/theme'
import type { ThemeColors } from '../../../constants/theme'

type MonoChoice = 'default' | 'single' | 'multi'

function monoChoiceOf(row: ServerRow | null): MonoChoice {
  if (!row || row.mono_channel_override === null || row.mono_channel_override === undefined) return 'default'
  return row.mono_channel_override === 1 ? 'single' : 'multi'
}

export default function ServerSettingsScreen() {
  const { serverId } = useLocalSearchParams<{ serverId?: string | string[] }>()
  const id = useMemo(() => {
    const v = Array.isArray(serverId) ? serverId[0] : serverId
    return v?.trim() ? v : undefined
  }, [serverId])

  const db = useDB()
  const { colors } = useTheme()
  const { top: safeTop, bottom: safeBottom } = useSafeAreaInsets()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [row, setRow] = useState<ServerRow | null>(null)
  const [name, setName] = useState('')
  const [savedAt, setSavedAt] = useState(0)

  const reload = useCallback(async () => {
    if (!id) return
    const r = await getServer(db, id)
    setRow(r)
    setName(r?.display_name ?? serverDisplayName(id))
  }, [db, id])

  useEffect(() => { reload().catch((e) => console.warn('[ServerSettings] load', e)) }, [reload])

  const monoChoice = monoChoiceOf(row)
  const advertised =
    row?.mono_channel_advertised === 1 ? 'single channel'
    : row?.mono_channel_advertised === 0 ? 'multiple channels'
    : 'not advertised'

  const pickImage = useCallback(async () => {
    if (!id) return
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) return
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.6,
      base64: true,
    })
    if (result.canceled) return
    const asset = result.assets[0]
    if (!asset.base64) return
    const mime = asset.mimeType ?? 'image/jpeg'
    await setServerAvatar(db, id, `data:${mime};base64,${asset.base64}`)
    await reload()
  }, [db, id, reload])

  const choosePreset = useCallback(async (glyph: string) => {
    if (!id) return
    await setServerAvatar(db, id, `emoji:${glyph}`)
    await reload()
  }, [db, id, reload])

  const clearAvatar = useCallback(async () => {
    if (!id) return
    await setServerAvatar(db, id, null)
    await reload()
  }, [db, id, reload])

  const setMono = useCallback(async (choice: MonoChoice) => {
    if (!id) return
    await setServerMonoOverride(db, id, choice === 'default' ? null : choice === 'single')
    await reload()
  }, [db, id, reload])

  const savedName = row?.display_name ?? (id ? serverDisplayName(id) : '')
  const dirty = name.trim().length > 0 && name.trim() !== savedName

  const commitName = useCallback(async () => {
    if (!id) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === (row?.display_name ?? serverDisplayName(id))) return
    await renameServer(db, id, trimmed)
    await reload()           // refresh baseline so header + dirty state reflect it
    setSavedAt(Date.now())   // flash a "Saved" confirmation
  }, [db, id, name, row, reload])

  return (
    <View style={[styles.screen, { paddingTop: safeTop }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8} accessibilityLabel="Go back">
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{savedName || 'Server'} settings</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: safeBottom + spacing.lg }}>
        {/* Avatar */}
        <Text style={styles.sectionLabel}>Avatar</Text>
        <View style={styles.card}>
          <View style={styles.avatarRow}>
            <ServerAvatar avatar={row?.avatar} status={row?.last_status ?? 'idle'} label={name || 'AI'} size={64} showStatus={false} />
            <View style={styles.avatarActions}>
              <Pressable style={styles.btn} onPress={() => pickImage().catch(console.warn)}>
                <Text style={styles.btnText}>Choose photo</Text>
              </Pressable>
              {row?.avatar ? (
                <Pressable style={styles.btnGhost} onPress={() => clearAvatar().catch(console.warn)}>
                  <Text style={styles.btnGhostText}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
          <View style={styles.presetRow}>
            {AVATAR_PRESETS.map((g) => (
              <Pressable key={g} style={styles.preset} onPress={() => choosePreset(g).catch(console.warn)}>
                <Text style={styles.presetGlyph}>{g}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Display name */}
        <Text style={styles.sectionLabel}>Name</Text>
        <View style={styles.card}>
          <View style={styles.nameRow}>
            <TextInput
              value={name}
              onChangeText={(t) => { setName(t); if (savedAt) setSavedAt(0) }}
              onEndEditing={() => commitName().catch(console.warn)}
              onSubmitEditing={() => commitName().catch(console.warn)}
              placeholder="Server name"
              placeholderTextColor={colors.textFaint}
              style={styles.nameInput}
              returnKeyType="done"
            />
            {dirty ? (
              <Pressable style={styles.saveBtn} onPress={() => commitName().catch(console.warn)} accessibilityLabel="Save name">
                <Text style={styles.saveBtnText}>Save</Text>
              </Pressable>
            ) : savedAt ? (
              <Text style={styles.savedText}>Saved ✓</Text>
            ) : null}
          </View>
        </View>

        {/* Mono-channel */}
        <Text style={styles.sectionLabel}>Channels</Text>
        <View style={styles.card}>
          <View style={styles.segmented}>
            {(['default', 'single', 'multi'] as MonoChoice[]).map((c) => (
              <Pressable
                key={c}
                style={[styles.segment, monoChoice === c && styles.segmentActive]}
                onPress={() => setMono(c).catch(console.warn)}
              >
                <Text style={[styles.segmentText, monoChoice === c && styles.segmentTextActive]}>
                  {c === 'default' ? 'Default' : c === 'single' ? 'Single' : 'Multiple'}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.hint}>
            Single-channel servers skip the channel list and open one chat directly.
            {'\n'}Advertised default: {advertised}.
          </Text>
        </View>
      </ScrollView>
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.sm,
    },
    backBtn: { paddingRight: spacing.xs },
    backText: { color: colors.accent, fontSize: 28, lineHeight: 32 },
    title: { color: colors.text, fontSize: typography.sizeXl, fontWeight: typography.weightSemibold, flex: 1 },
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
      padding: spacing.lg,
      gap: spacing.md,
    },
    avatarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    avatarActions: { flex: 1, gap: spacing.sm },
    btn: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' },
    btnText: { color: colors.bg, fontSize: typography.sizeMd, fontWeight: typography.weightSemibold },
    btnGhost: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' },
    btnGhostText: { color: colors.textMuted, fontSize: typography.sizeMd },
    presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    preset: {
      width: 44,
      height: 44,
      borderRadius: radius.full,
      backgroundColor: colors.surface2 ?? colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    presetGlyph: { fontSize: 22 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    nameInput: { flex: 1, color: colors.text, fontSize: typography.sizeLg, paddingVertical: 6 },
    saveBtn: { backgroundColor: colors.accent, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 6 },
    saveBtnText: { color: colors.bg, fontSize: typography.sizeMd, fontWeight: typography.weightSemibold },
    savedText: { color: colors.success, fontSize: typography.sizeMd, fontWeight: typography.weightMedium },
    segmented: {
      flexDirection: 'row',
      backgroundColor: colors.surface2 ?? colors.surface,
      borderRadius: radius.md,
      padding: 3,
      gap: 2,
    },
    segment: { flex: 1, paddingVertical: 8, borderRadius: radius.sm, alignItems: 'center' },
    segmentActive: { backgroundColor: colors.accent },
    segmentText: { color: colors.textMuted, fontSize: typography.sizeMd, fontWeight: typography.weightMedium },
    segmentTextActive: { color: '#fff', fontWeight: typography.weightSemibold },
    hint: { color: colors.textDim, fontSize: typography.sizeSm, lineHeight: typography.lineHeightNormal },
  })
}
