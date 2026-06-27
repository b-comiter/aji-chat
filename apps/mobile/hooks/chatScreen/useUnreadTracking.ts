import { useCallback, useEffect, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { SQLiteDatabase } from 'expo-sqlite'
import { getChannelLastRead, markChannelRead } from '../../db/database'
import { syncAppBadge } from '../../utils/badge'
import { setFocusedChat } from '../../utils/focusedChat'

type Params = {
  db: SQLiteDatabase
  resolvedServerId?: string
  resolvedChannel: string
}

export function useUnreadTracking({ db, resolvedServerId, resolvedChannel }: Params) {
  const [unreadBaseline, setUnreadBaseline] = useState<number | null>(null)
  const [openedAt, setOpenedAt] = useState<number | null>(null)

  useEffect(() => {
    if (!resolvedServerId) {
      setUnreadBaseline(null)
      setOpenedAt(null)
      return
    }
    let cancelled = false
    getChannelLastRead(db, resolvedServerId, resolvedChannel)
      .then((ts) => {
        if (cancelled) return
        setUnreadBaseline(ts)
        setOpenedAt(Date.now())
        markChannelRead(db, resolvedServerId, resolvedChannel)
          .then(() => syncAppBadge(db))
          .catch(() => {})
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [db, resolvedServerId, resolvedChannel])

  useFocusEffect(
    useCallback(() => {
      if (resolvedServerId) setFocusedChat(resolvedServerId, resolvedChannel)
      return () => {
        setFocusedChat(null)
        if (resolvedServerId) {
          markChannelRead(db, resolvedServerId, resolvedChannel)
            .then(() => syncAppBadge(db))
            .catch(() => {})
        }
      }
    }, [db, resolvedServerId, resolvedChannel]),
  )

  return { unreadBaseline, openedAt }
}
