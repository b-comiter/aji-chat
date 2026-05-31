/**
 * Pure helpers for `file` chat items. Lives in its own file (no React Native /
 * Expo imports) so tests can run without the native runtime — same rule as
 * toolSheetHelpers.ts.
 */

/** True when the mime type denotes audio we should render with a player. */
export function isAudioMime(mime: string): boolean {
  return mime.toLowerCase().startsWith('audio/')
}

// Common audio mime → file extension. Used to name the on-disk cache file so
// the OS audio player picks the right decoder.
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
