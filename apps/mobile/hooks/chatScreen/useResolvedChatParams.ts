import { useMemo } from 'react'
import { DEFAULT_CHANNEL } from '../../db/database'

type RouteParams = {
  serverId?: string | string[]
  channelId?: string | string[]
}

function resolveParam(value?: string | string[]) {
  const v = Array.isArray(value) ? value[0] : value
  return v?.trim() ? v : undefined
}

export function useResolvedChatParams({ serverId, channelId }: RouteParams) {
  const resolvedServerId = useMemo(() => resolveParam(serverId), [serverId])
  const resolvedChannel = useMemo(() => resolveParam(channelId) ?? DEFAULT_CHANNEL, [channelId])
  return { resolvedServerId, resolvedChannel }
}
