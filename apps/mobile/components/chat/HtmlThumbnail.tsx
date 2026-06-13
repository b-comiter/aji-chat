/**
 * Non-interactive thumbnail of an HTML `file` item, shown on top of its chat
 * chip so an arriving web page reads as a preview rather than a bare paperclip.
 *
 * The bytes are materialized to a cache file (same path the full-screen viewer
 * uses) and loaded into a small WebView that is:
 *   - laid out at a wide virtual viewport, then shrunk to the chip width, so the
 *     whole page reads as a miniature "screenshot" instead of a zoomed corner;
 *   - pinned to a light scheme + white canvas (matches the full viewer);
 *   - pointer-events-none and scroll-disabled, so taps fall through to the chip's
 *     Pressable (which opens the full-screen viewer).
 *
 * react-native-webview is a native module. If it isn't compiled into the running
 * app, rendering throws — an error boundary catches it and the thumbnail renders
 * nothing, so the chip silently degrades to its icon-only form. The same guard
 * covers a failed cache write.
 */
import { Component, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { writeFileToCache } from './fileCache'

type FilePayload = { id: string; mime: string; data: string; name?: string }

// Virtual page width the document lays out at before being scaled down to the
// chip. Wider = more of the page visible but smaller text; ~720 keeps headings
// legible while still showing layout structure.
const VIRTUAL_WIDTH = 720

// Force a desktop-width layout *before* the page's own scripts run, so the
// WebView shrinks the full page to fit rather than showing the top-left corner.
const FIT_VIEWPORT_JS = `
  var m = document.createElement('meta');
  m.name = 'viewport';
  m.content = 'width=${VIRTUAL_WIDTH}';
  (document.head || document.documentElement).appendChild(m);
  true;
`

// Runs after load: light scheme + white canvas so pages that set no background
// stay readable on the dark app theme (mirrors the full-screen viewer).
const FORCE_LIGHT_JS = `
  (function () {
    var el = document.documentElement;
    el.style.colorScheme = 'light';
    if (document.body && !document.body.style.backgroundColor) {
      document.body.style.backgroundColor = '#fff';
    }
  })();
  true;
`

export function HtmlThumbnail({ item, height = 150 }: { item: FilePayload; height?: number }) {
  return (
    <ThumbnailBoundary fallback={null}>
      <HtmlThumbnailInner item={item} height={height} />
    </ThumbnailBoundary>
  )
}

function HtmlThumbnailInner({ item, height }: { item: FilePayload; height: number }) {
  const [uri, setUri] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    writeFileToCache(item)
      .then((path) => { if (!cancelled) setUri(path) })
      .catch((err) => { console.warn('[HtmlThumbnail] cache write failed', err); if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [item.id, item.mime, item.name, item.data])

  if (failed) return null

  return (
    <View style={[styles.frame, { height }]} pointerEvents="none">
      {uri ? (
        <WebView
          source={{ uri }}
          style={styles.web}
          originWhitelist={['*']}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          forceDarkOn={false}
          injectedJavaScriptBeforeContentLoaded={FIT_VIEWPORT_JS}
          injectedJavaScript={FORCE_LIGHT_JS}
          // A preview should never navigate; swallow taps/links defensively even
          // though pointerEvents already blocks them.
          onShouldStartLoadWithRequest={(req) => req.url === uri || req.url.startsWith('file:')}
        />
      ) : (
        <View style={styles.placeholder} />
      )}
    </View>
  )
}

// Render-error boundary: if the WebView native module is missing (older dev
// client), drop the thumbnail entirely so the chip falls back to icon-only.
class ThumbnailBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err: unknown) {
    console.warn('[HtmlThumbnail] webview unavailable', (err as Error)?.message)
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  web: { flex: 1, backgroundColor: '#fff' },
  placeholder: { flex: 1, backgroundColor: '#fff' },
})
