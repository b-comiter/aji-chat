/**
 * Keeps the app icon badge in sync with the total unread count across all
 * servers — the same unread tally the home-screen pills use (sum of each
 * channel's messages since its last_read_at). Call after anything that changes
 * unread: a new incoming message, opening a chat (markChannelRead), or app
 * foreground.
 */
import * as Notifications from 'expo-notifications'
import type { SQLiteDatabase } from 'expo-sqlite'
import { getUnreadCounts } from '../db/database'

export async function syncAppBadge(db: SQLiteDatabase): Promise<void> {
  try {
    const counts = await getUnreadCounts(db)
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    await Notifications.setBadgeCountAsync(total)
  } catch {
    // Badge is best-effort — never let it disrupt event handling.
  }
}
