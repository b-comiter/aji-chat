import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import type { PromptOption } from '@aji/protocol'

function hexToRgb(hex: string): string {
  const c = hex.replace('#', '')
  return `${parseInt(c.slice(0, 2), 16)}, ${parseInt(c.slice(2, 4), 16)}, ${parseInt(c.slice(4, 6), 16)}`
}

type Props = {
  item: Extract<Item, { kind: 'prompt' }>
  onChoose: (id: string, choice: string) => void
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

type ParsedQuestion = {
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
}

type ParsedMessage = {
  subtitle?: string
  codeBlock?: string
  rationale?: string
  questions?: ParsedQuestion[]
}

function parsePermissionMessage(message: string): ParsedMessage {
  const sep = message.indexOf('\n\n')
  const rest = sep >= 0 ? message.slice(sep + 2).trim() : ''
  if (!rest) return {}

  try {
    const body = JSON.parse(rest) as Record<string, unknown>

    if (typeof body.command === 'string') {
      const cmd = body.command.trim()
      const desc = typeof body.description === 'string' ? body.description.trim() : undefined
      return { subtitle: desc, codeBlock: `$ ${cmd}` }
    }

    if (typeof body.file_path === 'string') {
      return { subtitle: body.file_path }
    }

    if (Array.isArray(body.questions)) {
      const questions: ParsedQuestion[] = body.questions.map((q: Record<string, unknown>) => ({
        question: String(q.question ?? ''),
        header: q.header ? String(q.header) : undefined,
        options: Array.isArray(q.options)
          ? q.options.map((o: Record<string, unknown>) => ({
              label: String(o.label ?? ''),
              description: o.description ? String(o.description) : undefined,
            }))
          : [],
      }))
      return { questions }
    }

    if (typeof body.plan === 'string') {
      const preview = body.plan.split('\n').slice(0, 3).join('\n').trim()
      return { subtitle: 'Plan', rationale: preview }
    }

    return {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PromptRow({ item, onChoose }: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [textValues, setTextValues] = useState<Record<string, string>>({})
  const parsed = useMemo(() => parsePermissionMessage(item.message), [item.message])

  const buttonOpts = item.options.filter((o) => !o.allowText)
  const orderedButtonOpts = useMemo(() => {
    const deny = buttonOpts.filter((o) => o.id === 'deny' || o.id === '/deny')
    const allow = buttonOpts.filter((o) => o.id.startsWith('allow') || o.id.startsWith('/approve'))
    const middle = buttonOpts.filter((o) => !deny.includes(o) && !allow.includes(o))
    return [...deny, ...middle, ...allow]
  }, [buttonOpts])

  const isPrimary = (o: PromptOption) => o.id.startsWith('allow') || o.id.startsWith('/approve')
  const isDanger = (o: PromptOption) => o.id === 'deny' || o.id === '/deny'

  if (item.resolved) {
    const denied = item.resolvedChoice === 'deny' || item.resolvedChoice === '/deny'
    return (
      <View style={styles.stub}>
        <Text style={denied ? styles.stubIconDeny : styles.stubIconAllow}>
          {denied ? '✕' : '✓'}
        </Text>
        <Text style={styles.stubLabel}>{item.choiceLabel}</Text>
        <Text style={styles.stubSep}>·</Text>
        <Text style={styles.stubTitle} numberOfLines={1}>{item.title}</Text>
      </View>
    )
  }

  const textOpts = item.options.filter((o) => o.allowText)

  return (
    <View style={styles.card}>
      {/* ── Header ── */}
      <View style={styles.head}>
        <View style={styles.dot} />
        <Text style={styles.title}>{item.title}</Text>
      </View>

      {/* ── Subtitle ── */}
      {parsed.subtitle ? (
        <Text style={styles.sub}>{parsed.subtitle}</Text>
      ) : null}

      {/* ── Code block ── */}
      {parsed.codeBlock ? (
        <View style={styles.codeWrap}>
          <Text style={styles.codeText} numberOfLines={5}>{parsed.codeBlock}</Text>
        </View>
      ) : null}

      {/* ── Rationale ── */}
      {parsed.rationale ? (
        <Text style={styles.rationale} numberOfLines={4}>{parsed.rationale}</Text>
      ) : null}

      {/* ── AskUserQuestion / multi-question display ── */}
      {parsed.questions?.map((q, qi) => (
        <View key={qi}>
          <View style={styles.questionHead}>
            {q.header ? (
              <Text style={styles.questionHeader}>{q.header}</Text>
            ) : null}
            <Text style={styles.questionText}>{q.question}</Text>
          </View>
          {q.options.map((opt, oi) => (
            <View key={oi} style={styles.qopt}>
              <View style={styles.qoptBody}>
                <Text style={styles.qoptLabel}>{opt.label}</Text>
                {opt.description ? (
                  <Text style={styles.qoptDesc} numberOfLines={3}>{opt.description}</Text>
                ) : null}
              </View>
              <Text style={styles.qoptNum}>{oi + 1}</Text>
            </View>
          ))}
        </View>
      ))}

      {/* ── Free-text options ── */}
      {textOpts.map((opt) => (
        <View key={opt.id} style={styles.textOptWrap}>
          <Text style={styles.textOptLabel}>{opt.label}</Text>
          <View style={styles.textOptRow}>
            <TextInput
              style={styles.textOptInput}
              value={textValues[opt.id] ?? ''}
              onChangeText={(v) => setTextValues((prev) => ({ ...prev, [opt.id]: v }))}
              placeholder="Type your answer…"
              placeholderTextColor={colors.textDim}
              returnKeyType="send"
              onSubmitEditing={() => {
                const val = (textValues[opt.id] ?? '').trim()
                if (val) onChoose(item.id, val)
              }}
            />
            <Pressable
              style={[styles.textOptBtn, !(textValues[opt.id] ?? '').trim() && styles.textOptBtnOff]}
              disabled={!(textValues[opt.id] ?? '').trim()}
              onPress={() => {
                const val = (textValues[opt.id] ?? '').trim()
                if (val) onChoose(item.id, val)
              }}
            >
              <Text style={styles.textOptBtnText}>→</Text>
            </Pressable>
          </View>
        </View>
      ))}

      {/* ── Actions ── */}
      {orderedButtonOpts.length > 0 && (
        <View style={styles.actions}>
          {orderedButtonOpts.map((opt, i) => (
            <Pressable
              key={opt.id}
              style={[
                styles.action,
                isPrimary(opt) && styles.actionPrimary,
                i < orderedButtonOpts.length - 1 && styles.actionBorder,
              ]}
              onPress={() => onChoose(item.id, opt.id)}
            >
              <Text style={[
                styles.actionText,
                isDanger(opt) && styles.actionTextDanger,
                isPrimary(opt) && styles.actionPrimaryText,
              ]}>
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  const warnRgb = hexToRgb(colors.warn)
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: `rgba(${warnRgb}, 0.6)`,
      overflow: 'hidden',
      shadowColor: colors.warn,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.2,
      shadowRadius: 6,
      elevation: 2,
    },
    head: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingHorizontal: spacing.lg,
      paddingTop: 14,
      paddingBottom: 10,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: radius.full,
      backgroundColor: colors.warn,
      marginTop: 6,
      flexShrink: 0,
      shadowColor: colors.warn,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.9,
      shadowRadius: 5,
    },
    title: {
      flex: 1,
      color: colors.text,
      fontSize: typography.size,
      fontWeight: typography.weightSemibold,
      lineHeight: 20,
    },
    sub: {
      color: colors.textMuted,
      fontSize: typography.sizeMd,
      paddingHorizontal: 14,
      paddingBottom: 10,
      lineHeight: 18,
    },
    codeWrap: {
      marginHorizontal: 14,
      marginBottom: 10,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      backgroundColor: colors.bg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    codeText: {
      fontFamily: typography.fontMono,
      fontSize: typography.sizeSm,
      color: colors.text,
      lineHeight: typography.lineHeightCode,
    },
    rationale: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
      paddingHorizontal: 14,
      paddingBottom: 12,
      lineHeight: 18,
    },
    // ── AskUserQuestion display ──
    questionHead: {
      paddingHorizontal: 14,
      paddingBottom: 4,
    },
    questionHeader: {
      color: colors.textDim,
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: 4,
    },
    questionText: {
      color: colors.text,
      fontSize: typography.size,
      fontWeight: typography.weightMedium,
      lineHeight: 20,
      marginBottom: 4,
    },
    qopt: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    qoptBody: { flex: 1 },
    qoptLabel: {
      color: colors.text,
      fontSize: typography.sizeMd,
      fontWeight: typography.weightMedium,
    },
    qoptDesc: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
      lineHeight: 16,
      marginTop: 2,
    },
    qoptNum: {
      fontFamily: typography.fontMono,
      fontSize: typography.sizeXs,
      color: colors.textMuted,
      backgroundColor: colors.surface3,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: radius.sm,
      flexShrink: 0,
      marginTop: 2,
    },
    // ── Actions ──
    actions: {
      borderTopWidth: 1,
      borderTopColor: colors.borderAlt,
    },
    action: {
      paddingHorizontal: spacing.lg,
      paddingVertical: 12,
    },
    actionBorder: {
      borderBottomWidth: 1,
      borderBottomColor: colors.borderAlt,
    },
    actionPrimary: {
      backgroundColor: colors.surface2,
    },
    actionText: {
      color: colors.text,
      fontSize: typography.sizeMd,
    },
    actionTextDanger: {
      color: colors.danger,
    },
    actionPrimaryText: {
      color: colors.text,
      fontWeight: typography.weightMedium,
    },
    // ── Resolved stub ──
    stub: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      backgroundColor: colors.surface2,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
    },
    stubIconAllow: { color: colors.success, fontSize: typography.sizeSm },
    stubIconDeny: { color: colors.textMuted, fontSize: typography.sizeSm },
    stubLabel: { color: colors.text, fontSize: typography.sizeSm, fontWeight: typography.weightMedium },
    stubSep: { color: colors.textMuted, fontSize: typography.sizeSm },
    stubTitle: { color: colors.textMuted, fontSize: typography.sizeSm, flexShrink: 1 },
    // ── Free-text option ──
    textOptWrap: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    textOptLabel: {
      color: colors.textMuted,
      fontSize: typography.sizeSm,
      fontWeight: typography.weightSemibold,
      marginBottom: 6,
    },
    textOptRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    textOptInput: {
      flex: 1,
      backgroundColor: colors.bg,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: colors.text,
      fontSize: typography.size,
      borderWidth: 1,
      borderColor: colors.borderAlt,
    },
    textOptBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    textOptBtnOff: { backgroundColor: colors.border },
    textOptBtnText: { color: colors.textOnAccent, fontSize: 18, fontWeight: typography.weightBold },
  })
}
