/**
 * Non-interactive thumbnail of a Markdown `file` item, shown on top of its chat
 * chip — the markdown sibling of HtmlThumbnail. Where the HTML preview renders a
 * shrunk WebView, this renders the decoded markdown with the app's shared
 * MarkdownMessage component (headings, lists, code) so the preview matches the
 * full-screen viewer's typography exactly.
 *
 * The decoded text is read from the same cache file the full viewer uses, then
 * truncated (a thumbnail never needs the whole doc) and rendered into a fixed-
 * height, overflow-clipped, pointer-events-none panel so taps fall through to the
 * chip's Pressable. MarkdownMessage draws into a plain View (not a nested
 * FlatList), so clipping it here is safe.
 */
import { Component, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { MarkdownMessage } from '../MarkdownMessage'
import { useTheme } from '../../context/ThemeContext'
import { spacing } from '../../constants/theme'
import type { ThemeColors } from '../../constants/theme'
import { readTextFromCache } from './fileCache'

type FilePayload = { id: string; mime: string; data: string; name?: string }

// Only the opening slice of the document is parsed — enough to fill the panel
// without paying to render a long file for a preview.
const PREVIEW_CHARS = 1200

export function MarkdownThumbnail({ item, height = 150 }: { item: FilePayload; height?: number }) {
  return (
    <ThumbnailBoundary fallback={null}>
      <MarkdownThumbnailInner item={item} height={height} />
    </ThumbnailBoundary>
  )
}

function MarkdownThumbnailInner({ item, height }: { item: FilePayload; height: number }) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [content, setContent] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    readTextFromCache(item)
      .then((text) => { if (!cancelled) setContent(text.slice(0, PREVIEW_CHARS)) })
      .catch((err) => { console.warn('[MarkdownThumbnail] read failed', err); if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [item.id, item.mime, item.name, item.data])

  if (failed) return null

  return (
    <View style={[styles.frame, { height }]} pointerEvents="none">
      {content ? (
        <View style={styles.pad}>
          <MarkdownMessage content={content} selectable={false} />
        </View>
      ) : null}
    </View>
  )
}

// Render-error boundary: markdown parsing on malformed input shouldn't take the
// whole chip down — drop the thumbnail and fall back to the icon-only chip.
class ThumbnailBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err: unknown) {
    console.warn('[MarkdownThumbnail] render failed', (err as Error)?.message)
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    frame: {
      width: '100%',
      backgroundColor: colors.bg,
      overflow: 'hidden',
    },
    pad: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  })
}
