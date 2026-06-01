import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'
import { DBProvider } from '../db/DBProvider'
import { WSProvider } from '../context/WebSocketContext'
import { ThemeProvider } from '../context/ThemeContext'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  useEffect(() => { SplashScreen.hideAsync() }, [])

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
