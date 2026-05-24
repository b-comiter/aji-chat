import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'
import { DBProvider } from '../db/DBProvider'
import { WSProvider } from '../context/WebSocketContext'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  useEffect(() => { SplashScreen.hideAsync() }, [])

  return (
    <DBProvider>
      <WSProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="chat" />
        </Stack>
      </WSProvider>
    </DBProvider>
  )
}
