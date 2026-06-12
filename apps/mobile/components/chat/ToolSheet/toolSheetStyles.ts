import { StyleSheet } from 'react-native'
import { radius, spacing, typography } from '../../../constants/theme'
import type { ThemeColors } from '../../../constants/theme'

export function makeCardStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface2,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: 'hidden',
      marginBottom: spacing.sm,
    },
    cardHead: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      gap: spacing.sm,
    },
    chev: {
      fontSize: 10,
      color: colors.textDim,
      width: 12,
      marginTop: 8,
    },
    chevOpen: {
      transform: [{ rotate: '90deg' }],
    },
    iconWrap: {
      width: 28,
      height: 28,
      borderRadius: radius.full,
      backgroundColor: colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    icon: {
      fontSize: 14,
    },
    textBlock: {
      flex: 1,
      gap: 4,
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    name: {
      flex: 1,
      fontFamily: typography.fontMono,
      fontSize: typography.sizeMd,
      color: colors.text,
    },
    preview: {
      fontSize: typography.sizeSm,
      lineHeight: 18,
      color: colors.textMuted,
    },
    previewLabel: {
      color: colors.textDim,
      fontWeight: typography.weightSemibold,
    },
    detail: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      padding: spacing.md,
    },
    detailAnimatedWrap: {
      overflow: 'hidden',
    },
    section: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: spacing.sm,
    },
    sectionSpacing: {
      marginTop: spacing.sm,
    },
    detailLabel: {
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
      color: colors.textDim,
      letterSpacing: 0.6,
      marginBottom: spacing.xs,
    },
    codeShell: {
      backgroundColor: colors.bg,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    codeScrollContent: {
      maxHeight: 320,
    },
    codeScrollY: {
      maxHeight: 320,
    },
    codeScrollYContent: {
      flexGrow: 0,
    },
    codeScrollX: {},
    codeScrollXContent: {
      minWidth: '100%',
      flexGrow: 0,
    },
    codeInner: {
      padding: spacing.sm,
      minWidth: '100%',
    },
    code: {
      fontFamily: typography.fontMono,
      fontSize: typography.sizeSm,
      color: colors.text,
      lineHeight: typography.lineHeightCode,
    },
  })
}

export function makeSheetStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -50 },
      shadowOpacity: 0.4,
      shadowRadius: 30,
      elevation: 20,
      overflow: 'hidden',
    },
    dragHandleArea: {
      minHeight: 54,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    grabber: {
      width: 100,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.borderAlt,
      alignSelf: 'center',
    },
    dragHint: {
      marginTop: 6,
      fontSize: 11,
      color: colors.textDim,
      fontWeight: typography.weightSemibold,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    headerMain: {
      flex: 1,
    },
    title: {
      fontSize: typography.sizeMd,
      fontWeight: typography.weightSemibold,
      color: colors.text,
    },
    sub: {
      fontSize: typography.sizeSm,
      color: colors.textMuted,
      marginTop: 2,
    },
    summaryRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginTop: spacing.sm,
    },
    collapseAllBtn: {
      alignSelf: 'flex-start',
      marginTop: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs + 1,
      borderRadius: radius.full,
      backgroundColor: colors.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    collapseAllBtnText: {
      fontSize: typography.sizeXs,
      fontWeight: typography.weightSemibold,
      color: colors.accent,
      letterSpacing: 0.2,
    },
    summaryChip: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 5,
      borderRadius: radius.full,
      backgroundColor: colors.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    summaryChipText: {
      fontSize: typography.sizeXs,
      fontWeight: typography.weightMedium,
      color: colors.textMuted,
    },
    closeBtn: {
      width: 28,
      height: 28,
      borderRadius: radius.full,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    closeBtnText: {
      fontSize: 13,
      color: colors.textMuted,
    },
    body: {
      flex: 1,
    },
    bodyContent: {
      padding: spacing.md,
      paddingBottom: spacing.xl,
    },
    empty: {
      color: colors.textDim,
      fontSize: typography.sizeMd,
      textAlign: 'center',
      marginTop: typography.sizeMd,
    },
  })
}
