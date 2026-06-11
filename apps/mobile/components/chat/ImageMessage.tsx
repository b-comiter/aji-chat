/**
 * Inline image thumbnail for `file` items whose mime is `image/*`.
 *
 * The bytes arrive inline as base64 (see the `file` protocol event). RN's Image
 * renders a `data:` URI directly, so no cache file is needed just to display the
 * thumbnail (and no extra native module is required). The width is fixed and the
 * height follows the image's natural aspect ratio (reported via onLoad). Tapping
 * opens the full-screen FileViewer, which materializes the bytes for zoom +
 * share/save.
 */
import { useMemo, useState } from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'

type FileItem = Extract<Item, { kind: 'file' }>

const MAX_WIDTH = 240
const DEFAULT_RATIO = 4 / 3

export function ImageMessage({
  item,
  tint,
  onPress,
}: {
  item: FileItem
  tint: boolean
  onPress: (item: FileItem) => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [ratio, setRatio] = useState(DEFAULT_RATIO)

  const source = useMemo(
    () => ({ uri: `data:${item.mime};base64,${item.data}` }),
    [item.mime, item.data],
  )

  return (
    <View>
      <Pressable
        onPress={() => onPress(item)}
        accessibilityRole="imagebutton"
        accessibilityLabel={item.name ? `Image ${item.name}` : 'Image'}
        accessibilityHint="Opens the image full screen"
      >
        <Image
          source={source}
          style={[styles.image, { width: MAX_WIDTH, height: MAX_WIDTH / ratio }]}
          resizeMode="cover"
          onLoad={(e) => {
            const { width, height } = e.nativeEvent.source
            if (width > 0 && height > 0) setRatio(width / height)
          }}
        />
      </Pressable>
      {item.text ? (
        <Text style={[styles.caption, { color: tint ? '#fff' : colors.text }]}>{item.text}</Text>
      ) : null}
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    image: {
      borderRadius: radius.lg,
      backgroundColor: colors.surface2,
    },
    caption: {
      marginTop: spacing.sm,
      fontSize: typography.sizeLg,
      lineHeight: typography.lineHeightNormal,
    },
  })
}
