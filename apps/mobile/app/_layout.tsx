import { Stack } from 'expo-router'
import { View } from 'react-native'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'
import { DBProvider } from '../db/DBProvider'
import { WSProvider } from '../context/WebSocketContext'
import { ThemeProvider } from '../context/ThemeContext'
import { AudioPlayerProvider } from '../context/AudioPlayerContext'
import { MiniPlayer } from '../components/audio/MiniPlayer'
import { PushRegistrar } from '../hooks/usePushNotifications'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  useEffect(() => { SplashScreen.hideAsync() }, [])

  return (
    <DBProvider>
      <ThemeProvider>
        <WSProvider>
          <PushRegistrar />
          <AudioPlayerProvider>
            <View style={{ flex: 1 }}>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen name="server" />
                <Stack.Screen name="chat" />
                <Stack.Screen name="settings" />
              </Stack>
              {/* Floating "now playing" bar — overlays the top of every screen. */}
              <MiniPlayer />
            </View>
          </AudioPlayerProvider>
        </WSProvider>
      </ThemeProvider>
    </DBProvider>
  )
}
