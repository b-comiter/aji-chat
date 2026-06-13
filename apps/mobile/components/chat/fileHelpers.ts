/**
 * Pure helpers for `file` chat items. Lives in its own file (no React Native /
 * Expo imports) so tests can run without the native runtime — same rule as
 * toolSheetHelpers.ts.
 */

/** True when the mime type denotes audio we should render with a player. */
export function isAudioMime(mime: string): boolean {
  return mime.toLowerCase().startsWith('audio/')
}

/** True when the mime type denotes an image we render inline as a thumbnail. */
export function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith('image/')
}

/** True for PDFs — rendered full-screen in a WebView. */
export function isPdfMime(mime: string): boolean {
  return mime.toLowerCase() === 'application/pdf'
}

/** True for HTML — rendered full-screen in a WebView. */
export function isHtmlMime(mime: string): boolean {
  const m = mime.toLowerCase()
  return m === 'text/html' || m === 'application/xhtml+xml'
}

/** True for Markdown — rendered full-screen with the markdown renderer. */
export function isMarkdownMime(mime: string, name?: string): boolean {
  const m = mime.toLowerCase()
  if (m === 'text/markdown' || m === 'text/x-markdown') return true
  if (name) {
    const lower = name.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return true
  }
  return false
}

/** True for any plain-text family (the fallback text viewer). */
export function isTextMime(mime: string): boolean {
  return mime.toLowerCase().startsWith('text/')
}

/**
 * What kind of viewer/renderer a file item maps to. The chat row and the
 * full-screen FileViewer both switch on this. Order matters: a markdown file
 * is `text/markdown` (caught before the generic text fallback), and an audio
 * clip is `audio/*` (caught before anything else).
 */
export type FileViewerKind = 'audio' | 'image' | 'pdf' | 'html' | 'markdown' | 'text' | 'none'

export function fileViewerKind(file: { mime: string; name?: string }): FileViewerKind {
  if (isAudioMime(file.mime)) return 'audio'
  if (isImageMime(file.mime)) return 'image'
  if (isPdfMime(file.mime)) return 'pdf'
  if (isHtmlMime(file.mime)) return 'html'
  if (isMarkdownMime(file.mime, file.name)) return 'markdown'
  if (isTextMime(file.mime)) return 'text'
  return 'none'
}

/**
 * Feather icon name for a file chip, chosen by viewer kind. The return type is
 * the exact set of glyphs we use (a subset of Feather's names) so call sites can
 * pass it to <Feather name=…> without an `as any` cast. Kept as a string-literal
 * union rather than importing Feather's type, so this stays Expo-import-free.
 */
export type FileIconName = 'image' | 'file-text' | 'code' | 'music' | 'file'

export function fileIconName(file: { mime: string; name?: string }): FileIconName {
  switch (fileViewerKind(file)) {
    case 'image': return 'image'
    case 'pdf': return 'file-text'
    case 'html': return 'code'
    case 'markdown':
    case 'text': return 'file-text'
    case 'audio': return 'music'
    default: return 'file'
  }
}

// Common mime → file extension. Used to name the on-disk cache file so the OS
// (audio player / WebView) picks the right decoder or renderer.
const MIME_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/webm': 'webm',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/plain': 'txt',
}

/**
 * Pick a file extension for a blob: prefer a known mapping for the mime type,
 * else the extension from `name`, else 'bin'.
 */
export function extensionForMime(mime: string, name?: string): string {
  const fromMime = MIME_EXTENSIONS[mime.toLowerCase()]
  if (fromMime) return fromMime
  if (name && name.includes('.')) {
    const ext = name.slice(name.lastIndexOf('.') + 1).trim()
    if (ext) return ext.toLowerCase()
  }
  return 'bin'
}

/**
 * Short label for a file in the chat list preview: a speaker for audio, a
 * paperclip otherwise.
 */
export function filePreviewLabel(file: { mime: string; name?: string }): string {
  if (isAudioMime(file.mime)) return `🔊 ${file.name ?? 'Audio message'}`
  return `📎 ${file.name ?? file.mime}`
}

/** Approximate decoded byte count from a base64 string length (3 bytes / 4 chars). */
export function approxBytesFromBase64(base64: string): number {
  const len = base64.length
  if (len === 0) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((len * 3) / 4) - padding)
}

/** Human-readable byte size, e.g. "12 KB", "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}
