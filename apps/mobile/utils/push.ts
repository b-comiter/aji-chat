/**
 * Expo push token acquisition + foreground notification behavior.
 *
 * Remote push requires a real build (development/preview/production) — it does
 * not work in Expo Go (SDK 53+) or simulators. All failures here are soft:
 * permission denied, no projectId, or running on a simulator/web just yields a
 * null token and the app proceeds without notifications.
 */
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { isChatFocused } from './focusedChat'

// Foreground presentation. Local "chime" notifications play sound only (no
// banner). Push notifications from the server are shown as banners UNLESS the
// user is already on that chat (the in-app chime already played).
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as
      | { serverId?: string; channel?: string; chime?: boolean }
      | undefined
    if (data?.chime) {
      return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: true, shouldSetBadge: false }
    }
    const onThisChat = isChatFocused(data?.serverId, data?.channel)
    return {
      shouldShowBanner: !onThisChat,
      shouldShowList: !onThisChat,
      shouldPlaySound: !onThisChat,
      shouldSetBadge: false,
    }
  },
})

/**
 * Request permission (if not already granted) and return this device's Expo push
 * token, or null if unavailable. Safe to call on every mount — iOS only prompts
 * for permission once.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Messages',
        importance: Notifications.AndroidImportance.DEFAULT,
      })
    }

    const existing = await Notifications.getPermissionsAsync()
    let granted = existing.granted
    if (!granted && existing.canAskAgain) {
      const req = await Notifications.requestPermissionsAsync()
      granted = req.granted
    }
    if (!granted) return null

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
    if (!projectId) return null

    const token = await Notifications.getExpoPushTokenAsync({ projectId })
    return token.data
  } catch {
    return null
  }
}
