/**
 * Two-step model picker: provider list → model list within a provider.
 * Opened by the chat screen when the user sends /model with no arguments.
 *
 * Model IDs come from the server's `commands` event (the /model command's
 * `subcommands` field). Expected formats:
 *   "anthropic/claude-opus-4-8"   → provider prefix before the first "/"
 *   "llama-3-1-8b:free"           → ":free" suffix marks free-tier models
 *
 * When the user selects a model, `onSelect` fires with the raw model ID and
 * the caller is responsible for sending "/model <id>" to the agent.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing, typography } from '../../constants/theme'
import { useTheme } from '../../context/ThemeContext'
import type { ThemeColors } from '../../constants/theme'

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

type ProviderMeta = { label: string; init: string; avatarBg: string }

const PROVIDER_META: Record<string, ProviderMeta> = {
  openrouter:  { label: 'OpenRouter',  init: 'R', avatarBg: '#6B21A8' },
  anthropic:   { label: 'Anthropic',   init: 'A', avatarBg: '#5C2E00' },
  openai:      { label: 'OpenAI',      init: 'O', avatarBg: '#064E3B' },
  google:      { label: 'Google',      init: 'G', avatarBg: '#1E3A8A' },
  meta:        { label: 'Meta',        init: 'M', avatarBg: '#312E81' },
  mistral:     { label: 'Mistral',     init: 'm', avatarBg: '#78350F' },
  deepseek:    { label: 'DeepSeek',    init: 'D', avatarBg: '#164E63' },
  cohere:      { label: 'Cohere',      init: 'C', avatarBg: '#1E1B4B' },
  perplexity:  { label: 'Perplexity',  init: 'P', avatarBg: '#1F2937' },
  xai:         { label: 'xAI',         init: 'X', avatarBg: '#111827' },
  qwen:        { label: 'Qwen',        init: 'Q', avatarBg: '#0C4A6E' },
}

const FALLBACK_AVATAR_BG = '#374151'

// ---------------------------------------------------------------------------
// Model parsing
// ---------------------------------------------------------------------------

type ParsedModel = {
  /** Actual model ID sent to /model — no gateway prefix. */
  id: string
  label: string
  /** Gateway or AI provider slug — used for grouping. */
  providerId: string
  /** AI sub-provider when providerId is a gateway (e.g. "anthropic" inside "openrouter"). */
  subProvider?: string
  free: boolean
}

type ProviderGroup = {
  id: string
  label: string
  init: string
  avatarBg: string
  models: ParsedModel[]
}

function parseModel(rawId: string): ParsedModel {
  // :free suffix is OpenRouter's free-tier marker — strip before other parsing.
  const free = rawId.endsWith(':free')
  const withoutFree = free ? rawId.slice(0, -5) : rawId

  // New format: "gateway@model_id" (e.g. "openrouter@anthropic/claude-opus-4-8")
  // The gateway prefix is stripped before sending /model so Hermes gets the bare ID.
  const atIdx = withoutFree.indexOf('@')
  if (atIdx !== -1) {
    const providerId = withoutFree.slice(0, atIdx).toLowerCase()
    const modelId = withoutFree.slice(atIdx + 1)   // bare Hermes model ID
    const commandId = modelId + (free ? ':free' : '')

    // Sub-provider from first / in the model ID ("anthropic" from "anthropic/claude-opus-4-8")
    const slashIdx = modelId.indexOf('/')
    const subProvider = slashIdx !== -1 ? modelId.slice(0, slashIdx) : undefined
    const rawName = slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId
    const label = rawName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    return { id: commandId, label, providerId, subProvider, free }
  }

  // Legacy format: "provider/model-id" (e.g. "anthropic/claude-opus-4-8")
  const slashIdx = withoutFree.indexOf('/')
  const providerId = slashIdx !== -1 ? withoutFree.slice(0, slashIdx).toLowerCase() : 'other'
  const rawName = slashIdx !== -1 ? withoutFree.slice(slashIdx + 1) : withoutFree
  const label = rawName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return { id: rawId, label, providerId, free }
}

function buildProviderGroups(models: string[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>()
  for (const id of models) {
    const m = parseModel(id)
    if (!groups.has(m.providerId)) {
      const meta = PROVIDER_META[m.providerId]
      groups.set(m.providerId, {
        id: m.providerId,
        label: meta?.label ?? (m.providerId.charAt(0).toUpperCase() + m.providerId.slice(1)),
        init: meta?.init ?? m.providerId.charAt(0).toUpperCase(),
        avatarBg: meta?.avatarBg ?? FALLBACK_AVATAR_BG,
        models: [],
      })
    }
    groups.get(m.providerId)!.models.push(m)
  }
  return Array.from(groups.values())
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type SortOrder = 'az' | 'free-first'

type Props = {
  visible: boolean
  /** Raw model IDs from the /model command's subcommands field. */
  models: string[]
  /** Currently active model ID — shown with a checkmark and "current" tag. */
  currentModel?: string
  onSelect: (modelId: string) => void
  onClose: () => void
}

const SLIDE_MS = 220
const NAV_FLANK = 80 // equal left/right widths keep the title centered

export function ModelPicker({ visible, models, currentModel, onSelect, onClose }: Props) {
  const { colors } = useTheme()
  const { top: safeTop, bottom: safeBottom } = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [activeGroup, setActiveGroup] = useState<ProviderGroup | null>(null)
  const [sort, setSort] = useState<SortOrder>('az')
  // panelX: 0 = provider screen, -width = model screen
  const panelX = useRef(new Animated.Value(0)).current

  const providerGroups = useMemo(() => buildProviderGroups(models), [models])

  const sortedModels = useMemo(() => {
    if (!activeGroup) return []
    const ms = [...activeGroup.models]
    if (sort === 'az') ms.sort((a, b) => a.label.localeCompare(b.label))
    else if (sort === 'free-first') ms.sort((a, b) => (b.free ? 1 : 0) - (a.free ? 1 : 0))
    return ms
  }, [activeGroup, sort])

  const drillIn = useCallback(
    (group: ProviderGroup) => {
      setActiveGroup(group)
      Animated.timing(panelX, { toValue: -width, duration: SLIDE_MS, useNativeDriver: true }).start()
    },
    [panelX, width],
  )

  const goBack = useCallback(() => {
    Animated.timing(panelX, { toValue: 0, duration: SLIDE_MS, useNativeDriver: true }).start(
      () => setActiveGroup(null),
    )
  }, [panelX])

  const handleClose = useCallback(() => {
    panelX.setValue(0)
    setActiveGroup(null)
    setSort('az')
    onClose()
  }, [panelX, onClose])

  const handleSelect = useCallback(
    (modelId: string) => {
      onSelect(modelId)
      handleClose()
    },
    [onSelect, handleClose],
  )

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="slide"
      onRequestClose={handleClose}
    >
      <View style={[styles.root, { paddingTop: safeTop, paddingBottom: safeBottom }]}>
        {/* Horizontal slide rail — provider screen and model screen sit side by side */}
        <Animated.View
          style={[styles.rail, { width: width * 2, transform: [{ translateX: panelX }] }]}
        >

          {/* ── Screen 1: Provider list ──────────────────────────────── */}
          <View style={{ width, flex: 1 }}>
            <View style={styles.nav}>
              <View style={{ width: NAV_FLANK }} />
              <Text style={styles.navTitle}>Model</Text>
              <Pressable
                style={styles.navFlank}
                onPress={handleClose}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Close model picker"
              >
                <Text style={styles.closeText}>✕</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="always">
              {providerGroups.length === 0 ? (
                <Text style={styles.emptyText}>
                  No models available. The connected agent may not support /model.
                </Text>
              ) : (
                providerGroups.map((group) => {
                  const freeCount = group.models.filter((m) => m.free).length
                  const isCurrent = group.models.some((m) => m.id === currentModel)
                  return (
                    <Pressable
                      key={group.id}
                      style={({ pressed }) => [styles.providerRow, pressed && styles.rowPressed]}
                      onPress={() => drillIn(group)}
                      accessibilityRole="button"
                      accessibilityLabel={`${group.label}, ${group.models.length} models`}
                    >
                      <View style={[styles.avatar, { backgroundColor: group.avatarBg }]}>
                        <Text style={styles.avatarInit}>{group.init}</Text>
                      </View>
                      <View style={styles.providerInfo}>
                        <View style={styles.nameRow}>
                          <Text style={styles.providerName}>{group.label}</Text>
                          {isCurrent && (
                            <View style={styles.currentTag}>
                              <Text style={styles.currentTagText}>current</Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.providerSub}>
                          {group.models.length} model{group.models.length !== 1 ? 's' : ''}
                          {freeCount > 0 ? ` · ${freeCount} free` : ''}
                        </Text>
                      </View>
                      <Text style={styles.chevron}>›</Text>
                    </Pressable>
                  )
                })
              )}
            </ScrollView>
          </View>

          {/* ── Screen 2: Model list ─────────────────────────────────── */}
          <View style={{ width, flex: 1 }}>
            <View style={styles.nav}>
              <Pressable
                style={styles.navFlank}
                onPress={goBack}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Back to providers"
              >
                <Text style={styles.backText}>‹ Providers</Text>
              </Pressable>
              <Text style={styles.navTitle} numberOfLines={1}>
                {activeGroup?.label ?? ''}
              </Text>
              <Pressable
                style={styles.navFlank}
                onPress={handleClose}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Close model picker"
              >
                <Text style={styles.closeText}>✕</Text>
              </Pressable>
            </View>

            <View style={styles.sortStrip}>
              <Text style={styles.sortLabel}>Sort</Text>
              <Pressable
                style={[styles.sortBtn, sort === 'az' && styles.sortBtnOn]}
                onPress={() => setSort('az')}
              >
                <Text style={[styles.sortBtnText, sort === 'az' && styles.sortBtnTextOn]}>A–Z</Text>
              </Pressable>
              <Pressable
                style={[styles.sortBtn, sort === 'free-first' && styles.sortBtnOn]}
                onPress={() => setSort('free-first')}
              >
                <Text style={[styles.sortBtnText, sort === 'free-first' && styles.sortBtnTextOn]}>
                  Free first
                </Text>
              </Pressable>
            </View>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="always">
              {sortedModels.map((model) => {
                const isCurrent = model.id === currentModel
                return (
                  <Pressable
                    key={model.id}
                    style={({ pressed }) => [
                      styles.modelRow,
                      isCurrent && styles.modelRowCurrent,
                      pressed && styles.rowPressed,
                    ]}
                    onPress={() => handleSelect(model.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`${model.label}${model.free ? ', free' : ''}`}
                  >
                    <View style={styles.modelInfo}>
                      <Text style={styles.modelName}>{model.label}</Text>
                      <Text style={styles.modelId} numberOfLines={1}>
                        {model.subProvider ? `${model.subProvider}  ·  ` : ''}{model.id}
                      </Text>
                    </View>
                    {model.free && (
                      <View style={styles.freeBadge}>
                        <Text style={styles.freeBadgeText}>FREE</Text>
                      </View>
                    )}
                    {isCurrent && <Text style={styles.checkmark}>✓</Text>}
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>

        </Animated.View>
      </View>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.bg,
      overflow: 'hidden',
    },
    rail: {
      flex: 1,
      flexDirection: 'row',
    },
    // Nav bar
    nav: {
      height: 52,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    navTitle: {
      flex: 1,
      color: colors.text,
      fontSize: typography.sizeLg,
      fontWeight: typography.weightSemibold,
      textAlign: 'center',
    },
    navFlank: {
      width: NAV_FLANK,
      height: 44,
      justifyContent: 'center',
    },
    backText: {
      color: colors.accent,
      fontSize: typography.size,
    },
    closeText: {
      color: colors.textMuted,
      fontSize: 18,
      textAlign: 'right',
    },
    // Sort strip
    sortStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    sortLabel: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
      flex: 1,
    },
    sortBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.borderAlt,
    },
    sortBtnOn: {
      backgroundColor: colors.surface2,
      borderColor: colors.accent,
    },
    sortBtnText: {
      color: colors.textDim,
      fontSize: typography.sizeSm,
    },
    sortBtnTextOn: {
      color: colors.accent,
    },
    // Lists
    list: { flex: 1 },
    listContent: { paddingBottom: spacing.lg },
    rowPressed: { opacity: 0.6 },
    // Provider rows
    providerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    avatar: {
      width: 38,
      height: 38,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: spacing.md,
      flexShrink: 0,
    },
    avatarInit: {
      color: '#FFFFFF',
      fontSize: typography.sizeLg,
      fontWeight: typography.weightSemibold,
    },
    providerInfo: { flex: 1 },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: 2,
    },
    providerName: {
      color: colors.text,
      fontSize: typography.size,
    },
    providerSub: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
    },
    currentTag: {
      backgroundColor: colors.surface2,
      borderWidth: 1,
      borderColor: colors.borderAlt,
      borderRadius: 4,
      paddingHorizontal: spacing.xs,
      paddingVertical: 1,
    },
    currentTagText: {
      color: colors.accent,
      fontSize: 10,
    },
    chevron: {
      color: colors.textFaint,
      fontSize: 22,
      lineHeight: 26,
    },
    // Model rows
    modelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    modelRowCurrent: {
      backgroundColor: colors.surface2,
    },
    modelInfo: { flex: 1 },
    modelName: {
      color: colors.text,
      fontSize: typography.size,
      marginBottom: 2,
    },
    modelId: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
      fontFamily: typography.fontMono,
    },
    freeBadge: {
      backgroundColor: colors.surface3,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      marginRight: spacing.sm,
    },
    freeBadgeText: {
      color: '#4ade80',
      fontSize: 10,
      fontWeight: typography.weightSemibold,
    },
    checkmark: {
      color: colors.accent,
      fontSize: typography.size,
    },
    emptyText: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
      textAlign: 'center',
      paddingTop: spacing.xxxl,
      paddingHorizontal: spacing.xl,
    },
  })
}
