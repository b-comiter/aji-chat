/**
 * Acquires the Expo push token once and (re)registers it with the server on
 * every WS (re)connect, so the server can deliver a push when a new message
 * arrives while the app is backgrounded or killed.
 *
 * Re-sending on reconnect is intentional: the server persists tokens, but a
 * fresh server (or one whose data dir was reset) would otherwise never learn
 * this device until the next app restart.
 */
import { useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { router, useRootNavigationState } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { useWS } from '../context/WebSocketContext'
import { useDB } from '../db/DBProvider'
import { getAllServers, isServerMuted } from '../db/database'
import { registerForPushNotificationsAsync } from '../utils/push'

const PLATFORM = Platform.OS === 'android' ? 'android' : 'ios'

/** Navigate to the chat a tapped notification points at (deep-link). Uses the
 *  same string-path form the rest of the app navigates with. */
function openChatFromNotification(data: unknown): void {
  const d = data as { serverId?: string; channel?: string } | undefined
  if (!d?.serverId) return
  router.push(`/chat/${d.serverId}/${d.channel ?? 'general'}`)
}

export function usePushNotifications(): void {
  const { conn, sendEvent } = useWS()
  const db = useDB()
  const navState = useRootNavigationState()
  const tokenRef = useRef<string | null>(null)
  const acquired = useRef(false)
  // The conversation a tapped notification wants to open, held until the root
  // navigator is mounted (a cold-start tap fires before navigation is ready).
  const [pendingChat, setPendingChat] = useState<unknown>(null)

  // Acquire the token once on mount (prompts for permission the first time).
  useEffect(() => {
    if (acquired.current) return
    acquired.current = true
    registerForPushNotificationsAsync().then((token) => {
      tokenRef.current = token
      if (token && conn === 'connected') {
        sendEvent({ type: 'register_push', token, platform: PLATFORM })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Register the token + sync mute state on every (re)connect. Mute is synced in
  // full (every server, not just muted ones) so the server's view matches the
  // phone exactly even after an offline toggle or a reinstall.
  useEffect(() => {
    if (conn !== 'connected') return
    if (tokenRef.current) {
      sendEvent({ type: 'register_push', token: tokenRef.current, platform: PLATFORM })
    }
    getAllServers(db)
      .then((servers) => {
        for (const s of servers) {
          sendEvent({ type: 'set_mute', serverId: s.id, muted: isServerMuted(s) })
        }
      })
      .catch(() => {})
  }, [conn, sendEvent, db])

  // Deep-link: tapping a notification opens that conversation. Capture the
  // target from both a warm tap (listener) and a cold start where the app was
  // launched by the tap (getLastNotificationResponseAsync), then stash it.
  useEffect(() => {
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (resp) setPendingChat(resp.notification.request.content.data)
    })
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      setPendingChat(resp.notification.request.content.data)
    })
    return () => sub.remove()
  }, [])

  // Navigate once the root navigator is mounted (navState gains a key). Without
  // this gate a cold-start tap pushes before navigation exists and is dropped,
  // leaving the user on the default home screen.
  useEffect(() => {
    if (navState?.key && pendingChat != null) {
      openChatFromNotification(pendingChat)
      setPendingChat(null)
    }
  }, [navState?.key, pendingChat])
}

/** Headless mount point — renders nothing, just runs the registration effect. */
export function PushRegistrar(): null {
  usePushNotifications()
  return null
}
