import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import type { SQLiteDatabase } from 'expo-sqlite'
import type { Item } from '../chatTypes'
import { deleteItem } from '../../db/database'
import {
  type MessageMenuTarget,
  type Rect,
  messageCopyText,
} from '../../components/chat/MessageActionMenu'

type SetItems = (updater: (prev: Item[]) => Item[]) => void

type Params = {
  db: SQLiteDatabase
  setItems: SetItems
}

export function useMessageActions({ db, setItems }: Params) {
  const [menuTarget, setMenuTarget] = useState<MessageMenuTarget | null>(null)

  const handleLongPressItem = useCallback((item: Item, rect: Rect) => {
    setMenuTarget({ item, rect })
  }, [])

  const closeMessageMenu = useCallback(() => {
    setMenuTarget(null)
  }, [])

  const handleCopyItem = useCallback(async (item: Item) => {
    const text = messageCopyText(item)
    if (text) await Clipboard.setStringAsync(text)
  }, [])

  const handleDeleteItem = useCallback((item: Item) => {
    // Local-only delete: protocol has no single-message delete event.
    Alert.alert(
      'Delete message',
      'Remove this message from this device? This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setItems((prev) => prev.filter((it) => it.id !== item.id))
            deleteItem(db, item.id).catch(console.warn)
          },
        },
      ],
    )
  }, [db, setItems])

  return {
    menuTarget,
    handleLongPressItem,
    closeMessageMenu,
    handleCopyItem,
    handleDeleteItem,
  }
}
