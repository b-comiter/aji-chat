import { useMemo } from 'react'
import { View, StyleSheet } from 'react-native'
import type { ReactNode } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../../context/ThemeContext'
import { spacing } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { useAudioPlayerContext } from '../../context/AudioPlayerContext'
import { MINI_PLAYER_BAR_HEIGHT } from '../audio/MiniPlayer'

export function AppHeader({
  left,
  title,
  right,
}: {
  left?: ReactNode
  title: ReactNode
  right?: ReactNode
}) {
  const { colors } = useTheme()
  const { top: safeTop } = useSafeAreaInsets()
  const { activeTrack } = useAudioPlayerContext()
  const styles = useMemo(() => makeStyles(colors), [colors])
  // The mini-player floats over the top of every screen (a top overlay in the
  // root layout). When it's visible, drop the header below it so it isn't
  // covered — the bar consumes the safe-area inset, so we add only its content
  // height here.
  const topPad = safeTop + spacing.md + (activeTrack ? MINI_PLAYER_BAR_HEIGHT : 0)
  return (
    <View style={[styles.header, { paddingTop: topPad }]}>
      {left}
      <View style={styles.title}>{title}</View>
      {right}
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
      backgroundColor: colors.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.sm,
    },
    title: { flex: 1 },
  })
}
