/**
 * Full-screen viewer for a `file` chat item. Rendered as a slide-up Modal at the
 * chat-screen level (mirrors ToolSheet). Switches on the file's viewer kind:
 *
 *   image     — pinch-to-zoom Image on a dark backdrop (iOS ScrollView zoom)
 *   markdown  — decoded UTF-8 rendered with the shared MarkdownMessage renderer
 *   text      — decoded UTF-8 in a monospace ScrollView
 *   html/pdf  — WebView pointed at the materialized cache file
 *   else      — "can't preview" placeholder with file metadata
 *
 * The selected Item is passed in directly (base64 already in memory); html/pdf
 * need a file:// URI so we materialize the bytes to cache on open.
 */
import { Component, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView } from 'react-native-webview'
import { MarkdownMessage } from '../MarkdownMessage'
import { useTheme } from '../../context/ThemeContext'
import { spacing, typography, radius } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import type { Item } from '../../hooks/chatTypes'
import { fileViewerKind, fileIconName, approxBytesFromBase64, formatBytes } from './fileHelpers'
import { writeFileToCache, readTextFromCache } from './fileCache'

type FileItem = Extract<Item, { kind: 'file' }>

// expo-media-library is a native module — saving to Photos needs it compiled
// into the app binary. Load it defensively so a dev client that predates the
// dependency degrades (the Save button hides) instead of crashing on import.
// Sharing uses RN's built-in Share API, which needs no extra native module.
let MediaLibrary: typeof import('expo-media-library') | null = null
try {
  MediaLibrary = require('expo-media-library')
} catch {
  MediaLibrary = null
}

// Runs after an HTML document loads: force a light color-scheme and a white
// canvas so pages that don't set their own background stay readable on top of
// the dark app theme. Returns true so the WebView doesn't warn about the result.
const FORCE_LIGHT_JS = `
  (function () {
    var el = document.documentElement;
    el.style.colorScheme = 'light';
    if (!document.querySelector('meta[name="color-scheme"]')) {
      var m = document.createElement('meta');
      m.name = 'color-scheme';
      m.content = 'light only';
      (document.head || el).appendChild(m);
    }
    if (document.body && !document.body.style.backgroundColor) {
      document.body.style.backgroundColor = '#fff';
    }
  })();
  true;
`

export function FileViewer({ item, onClose }: { item: FileItem | null; onClose: () => void }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const insets = useSafeAreaInsets()

  const kind = item ? fileViewerKind(item) : 'none'
  const isImage = kind === 'image'
  const title = item?.name ?? item?.mime ?? 'File'
  const tintColor = isImage ? '#fff' : colors.text

  // Materialize the bytes to a cache file so the header's share/save actions
  // have a file:// URI to hand off. Idempotent with the body's own write.
  const [fileUri, setFileUri] = useState<string | null>(null)
  useEffect(() => {
    if (!item) { setFileUri(null); return }
    let cancelled = false
    writeFileToCache(item)
      .then((uri) => { if (!cancelled) setFileUri(uri) })
      .catch((err) => console.warn('[FileViewer] materialize failed', err))
    return () => { cancelled = true }
  }, [item?.id, item?.mime, item?.name, item?.data])

  const handleShare = useCallback(async () => {
    if (!fileUri || !item) return
    try {
      // RN's Share opens the OS share sheet; `url` hands off the file on iOS.
      await Share.share({ url: fileUri, title: item.name })
    } catch (err) {
      console.warn('[FileViewer] share failed', err)
    }
  }, [fileUri, item])

  const handleSaveImage = useCallback(async () => {
    if (!fileUri || !MediaLibrary) return
    try {
      const perm = await MediaLibrary.requestPermissionsAsync()
      if (!perm.granted) {
        Alert.alert('Photos access required', 'Allow photo access in Settings to save images.')
        return
      }
      await MediaLibrary.saveToLibraryAsync(fileUri)
      Alert.alert('Saved', 'Image saved to your photo library.')
    } catch (err) {
      console.warn('[FileViewer] save failed', err)
      Alert.alert('Could not save', 'The image could not be saved.')
    }
  }, [fileUri])

  return (
    <Modal
      visible={item !== null}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={[styles.container, isImage && styles.containerDark, { paddingTop: insets.top }]}>
        <View style={[styles.header, isImage && styles.headerDark]}>
          <Text
            style={[styles.title, isImage && styles.titleDark]}
            numberOfLines={1}
          >
            {title}
          </Text>
          {isImage && MediaLibrary && (
            <Pressable
              onPress={handleSaveImage}
              disabled={!fileUri}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Save image to photos"
              style={[styles.headerBtn, !fileUri && styles.headerBtnDisabled]}
            >
              <Feather name="download" size={22} color={tintColor} />
            </Pressable>
          )}
          <Pressable
            onPress={handleShare}
            disabled={!fileUri}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Share file"
            style={[styles.headerBtn, !fileUri && styles.headerBtnDisabled]}
          >
            <Feather name="share" size={20} color={tintColor} />
          </Pressable>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={styles.headerBtn}
          >
            <Feather name="x" size={24} color={tintColor} />
          </Pressable>
        </View>
        {item && <FileBody item={item} colors={colors} styles={styles} />}
      </View>
    </Modal>
  )
}

function FileBody({
  item,
  colors,
  styles,
}: {
  item: FileItem
  colors: ThemeColors
  styles: ReturnType<typeof makeStyles>
}) {
  const kind = fileViewerKind(item)

  if (kind === 'image') {
    return (
      <ScrollView
        style={styles.imageScroll}
        contentContainerStyle={styles.imageContent}
        maximumZoomScale={4}
        minimumZoomScale={1}
        centerContent
      >
        <Image
          source={{ uri: `data:${item.mime};base64,${item.data}` }}
          style={styles.fullImage}
          resizeMode="contain"
        />
      </ScrollView>
    )
  }

  if (kind === 'html' || kind === 'pdf') {
    return <CachedWebView item={item} colors={colors} styles={styles} />
  }

  if (kind === 'markdown' || kind === 'text') {
    return <TextBody item={item} kind={kind} colors={colors} styles={styles} />
  }

  // Unsupported — show metadata and a graceful message.
  const bytes = approxBytesFromBase64(item.data)
  return (
    <View style={styles.unsupported}>
      <Feather name={fileIconName(item) as any} size={48} color={colors.textDim} />
      <Text style={styles.unsupportedName}>{item.name ?? item.mime}</Text>
      <Text style={styles.unsupportedMeta}>{item.mime} · {formatBytes(bytes)}</Text>
      <Text style={styles.unsupportedHint}>Preview isn't available for this file type.</Text>
    </View>
  )
}

function CachedWebView({
  item,
  colors,
  styles,
}: {
  item: FileItem
  colors: ThemeColors
  styles: ReturnType<typeof makeStyles>
}) {
  const [uri, setUri] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    writeFileToCache(item)
      .then((path) => { if (!cancelled) setUri(path) })
      .catch((err) => { console.warn('[FileViewer] cache write failed', err); if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [item.id, item.mime, item.name, item.data])

  if (failed) {
    return (
      <View style={styles.unsupported}>
        <Text style={styles.unsupportedHint}>Could not load this file.</Text>
      </View>
    )
  }
  if (!uri) return <Centered color={colors.accent} />

  const isHtml = fileViewerKind(item) === 'html'

  // react-native-webview is a native module. If it isn't compiled into the
  // running app (e.g. a dev client built before it was added), rendering throws
  // a JS invariant — catch it and offer an open-externally fallback instead of
  // red-screening. Rebuilding the dev client restores the in-app viewer.
  return (
    <RenderBoundary fallback={<WebViewUnavailable item={item} uri={uri} colors={colors} styles={styles} />}>
      <WebView
        source={{ uri }}
        style={styles.webview}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        startInLoadingState
        renderLoading={() => <Centered color={colors.accent} />}
        // Pin documents to a light scheme so a page that doesn't declare its own
        // colors isn't auto-darkened by the OS dark appearance (unreadable
        // dark-on-dark). PDFs ignore this; their white WebView surface covers it.
        forceDarkOn={false}
        injectedJavaScript={isHtml ? FORCE_LIGHT_JS : undefined}
      />
    </RenderBoundary>
  )
}

class RenderBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err: unknown) {
    console.warn('[FileViewer] document renderer unavailable', (err as Error)?.message)
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function WebViewUnavailable({
  item,
  uri,
  colors,
  styles,
}: {
  item: FileItem
  uri: string
  colors: ThemeColors
  styles: ReturnType<typeof makeStyles>
}) {
  return (
    <View style={styles.unsupported}>
      <Feather name={fileIconName(item) as any} size={48} color={colors.textDim} />
      <Text style={styles.unsupportedName}>{item.name ?? item.mime}</Text>
      <Text style={styles.unsupportedHint}>
        In-app preview isn’t available in this build. Open it in another app instead.
      </Text>
      <Pressable
        onPress={() => Share.share({ url: uri, title: item.name }).catch(() => {})}
        style={styles.fallbackBtn}
        accessibilityRole="button"
        accessibilityLabel="Open file in another app"
      >
        <Feather name="share" size={16} color="#fff" />
        <Text style={styles.fallbackBtnText}>Open / Share</Text>
      </Pressable>
    </View>
  )
}

function TextBody({
  item,
  kind,
  colors,
  styles,
}: {
  item: FileItem
  kind: 'markdown' | 'text'
  colors: ThemeColors
  styles: ReturnType<typeof makeStyles>
}) {
  const [content, setContent] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    readTextFromCache(item)
      .then((text) => { if (!cancelled) setContent(text) })
      .catch((err) => { console.warn('[FileViewer] text read failed', err); if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [item.id, item.mime, item.name, item.data])

  if (failed) {
    return (
      <View style={styles.unsupported}>
        <Text style={styles.unsupportedHint}>Could not read this file.</Text>
      </View>
    )
  }
  if (content === null) return <Centered color={colors.accent} />

  // MarkdownMessage renders its own FlatList (a VirtualizedList) — it must not
  // be nested in a ScrollView. It scrolls itself, so give it a flex container.
  // Plain text has no inner list, so a ScrollView is correct there.
  if (kind === 'markdown') {
    return (
      <View style={styles.mdContainer}>
        <MarkdownMessage content={content} />
      </View>
    )
  }
  return (
    <ScrollView style={styles.textScroll} contentContainerStyle={styles.textContent}>
      <Text style={styles.plainText} selectable>{content}</Text>
    </ScrollView>
  )
}

function Centered({ color }: { color: string }) {
  return (
    <View style={centeredStyle.wrap}>
      <ActivityIndicator color={color} />
    </View>
  )
}

const centeredStyle = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    containerDark: { backgroundColor: '#000' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    headerDark: { borderBottomColor: 'rgba(255,255,255,0.15)' },
    title: { flex: 1, color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold },
    titleDark: { color: '#fff' },
    headerBtn: { padding: spacing.xs },
    headerBtnDisabled: { opacity: 0.4 },

    imageScroll: { flex: 1, backgroundColor: '#000' },
    imageContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
    fullImage: { width: '100%', height: '100%' },

    // Documents render on a white "paper" surface so HTML/PDF that doesn't set
    // its own background stays readable regardless of the app's (dark) theme.
    webview: { flex: 1, backgroundColor: '#fff' },

    mdContainer: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
    textScroll: { flex: 1 },
    textContent: { padding: spacing.lg },
    plainText: {
      color: colors.text,
      fontFamily: typography.fontMono,
      fontSize: typography.sizeMd,
      lineHeight: typography.lineHeightCode,
    },

    unsupported: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
    unsupportedName: { color: colors.text, fontSize: typography.sizeLg, fontWeight: typography.weightSemibold, textAlign: 'center' },
    unsupportedMeta: { color: colors.textDim, fontSize: typography.sizeSm },
    unsupportedHint: { color: colors.textMuted, fontSize: typography.sizeMd, textAlign: 'center' },
    fallbackBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.sm,
      backgroundColor: colors.accent,
      borderRadius: radius.full,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    fallbackBtnText: { color: '#fff', fontSize: typography.sizeMd, fontWeight: typography.weightSemibold },
  })
}
