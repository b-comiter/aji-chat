import { useCallback } from 'react'
import { View } from 'react-native'
import { DaySeparator } from '../../components/chat/DaySeparator'
import { NewMessagesDivider } from '../../components/chat/NewMessagesDivider'
import { Row } from '../../components/chat/MessageRow'
import type { Item } from '../chatTypes'

type Params = {
  groupStartIds: Set<string>
  dividerMap: Map<string, 'light' | 'heavy' | 'none'>
  daySeparators: Map<string, string>
  newMessagesDividerId: string | null
  toolsByAgentMsgId: Map<string, Item[]>
  respond: (id: string, choice: string) => void
  avatarLabel: string
  serverId?: string
  channelId?: string
  serverName: string
  onOpenTools: (tools: Item[]) => void
  onOpenFile: (item: Extract<Item, { kind: 'file' }>) => void
  onLongPressItem: (item: Item, rect: { x: number; y: number; width: number; height: number }) => void
}

export function useChatRowRenderer({
  groupStartIds,
  dividerMap,
  daySeparators,
  newMessagesDividerId,
  toolsByAgentMsgId,
  respond,
  avatarLabel,
  serverId,
  channelId,
  serverName,
  onOpenTools,
  onOpenFile,
  onLongPressItem,
}: Params) {
  return useCallback(
    ({ item }: { item: Item }) => {
      const isGroupStart = groupStartIds.has(item.id)
      const dividerKind = dividerMap.get(item.id) ?? 'none'
      const tools =
        item.kind === 'message' && item.role === 'assistant'
          ? toolsByAgentMsgId.get(item.id) ?? []
          : []
      const daySeparator = daySeparators.get(item.id)

      // Inverted FlatList cells render children in reversed column flow.
      // Wrapping siblings in one View preserves intended top-to-bottom order.
      return (
        <View>
          {daySeparator ? <DaySeparator label={daySeparator} /> : null}
          {item.id === newMessagesDividerId ? <NewMessagesDivider /> : null}
          <Row
            item={item}
            onChoose={respond}
            isGroupStart={isGroupStart}
            dividerKind={dividerKind}
            tools={tools}
            avatarLabel={avatarLabel}
            onOpenTools={onOpenTools}
            onOpenFile={onOpenFile}
            onLongPressItem={onLongPressItem}
            serverId={serverId}
            channelId={channelId}
            serverName={serverName}
          />
        </View>
      )
    },
    [
      avatarLabel,
      channelId,
      daySeparators,
      dividerMap,
      groupStartIds,
      newMessagesDividerId,
      onLongPressItem,
      onOpenFile,
      onOpenTools,
      respond,
      serverId,
      serverName,
      toolsByAgentMsgId,
    ],
  )
}
