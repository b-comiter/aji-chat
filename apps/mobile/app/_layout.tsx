import { Stack, useRouter } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { useEffect } from 'react'
import { DBProvider } from '../db/DBProvider'
import { WSProvider } from '../context/WebSocketContext'
import { ThemeProvider } from '../context/ThemeContext'

SplashScreen.preventAutoHideAsync()

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

export default function RootLayout() {
  const router = useRouter()

  useEffect(() => { SplashScreen.hideAsync() }, [])

  useEffect(() => {
    if (Platform.OS === 'android') {
      Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
      })
    }
    Notifications.requestPermissionsAsync()

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const chatId = response.notification.request.content.data?.chatId as string | undefined
      if (chatId) router.push(`/chat/${chatId}`)
    })
    return () => sub.remove()
  }, [router])

  return (
    <DBProvider>
      <ThemeProvider>
        <WSProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="chat" />
            <Stack.Screen name="settings" />
          </Stack>
        </WSProvider>
      </ThemeProvider>
    </DBProvider>
  )
}
