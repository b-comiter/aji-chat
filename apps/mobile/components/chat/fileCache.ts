/**
 * Materializes a `file` item's inline base64 payload to a stable cache file and
 * returns its file:// URI. Native modules (expo-audio, react-native-webview)
 * consume a URI rather than raw base64, so we write the bytes to disk once
 * (named by item id) and reuse the file across renders and app restarts.
 *
 * Kept separate from fileHelpers.ts so that file stays pure (Expo-free) and
 * unit-testable; this module touches the native filesystem.
 */
import * as FileSystem from 'expo-file-system/legacy'
import { extensionForMime } from './fileHelpers'

type FilePayload = { id: string; mime: string; data: string; name?: string }

/** Stable cache path for a file item, named by id + a mime-derived extension. */
export function cacheUriFor(file: FilePayload): string {
  return `${FileSystem.cacheDirectory}aji-file-${file.id}.${extensionForMime(file.mime, file.name)}`
}

/**
 * Write the base64 payload to its cache file (once) and return the file:// URI.
 * Re-materializes from the stored base64 if the cache file is missing.
 */
export async function writeFileToCache(file: FilePayload): Promise<string> {
  const path = cacheUriFor(file)
  const info = await FileSystem.getInfoAsync(path)
  if (!info.exists) {
    await FileSystem.writeAsStringAsync(path, file.data, {
      encoding: FileSystem.EncodingType.Base64,
    })
  }
  return path
}

/** Read a text file's bytes back as a UTF-8 string (used for markdown/plain text). */
export async function readTextFromCache(file: FilePayload): Promise<string> {
  const path = await writeFileToCache(file)
  return FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.UTF8 })
}
