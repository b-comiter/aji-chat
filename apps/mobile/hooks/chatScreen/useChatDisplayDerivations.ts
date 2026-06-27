import { useMemo } from 'react'
import { parseEditDiff } from '../../components/chat/diffHelpers'
import { formatDaySeparator, sameCalendarDay } from '../../components/chat/timeHelpers'
import type { Item } from '../chatTypes'

type Params = {
  items: Item[]
  agentStatus: 'thinking' | 'working' | 'idle'
  unreadBaseline: number | null
  openedAt: number | null
}

export function useChatDisplayDerivations({ items, agentStatus, unreadBaseline, openedAt }: Params) {
  const diffToolIds = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) {
      if (it.kind === 'tool' && parseEditDiff(it.name, it.args, it.result)) set.add(it.id)
    }
    return set
  }, [items])

  const toolsByAgentMsgId = useMemo(() => {
    const map = new Map<string, Item[]>()
    let lastAgentMsgId: string | null = null
    for (const it of items) {
      if (it.kind === 'message' && it.role === 'assistant') {
        lastAgentMsgId = it.id
      } else if (it.kind === 'tool' && !diffToolIds.has(it.id) && lastAgentMsgId) {
        const arr = map.get(lastAgentMsgId) ?? []
        arr.push(it)
        map.set(lastAgentMsgId, arr)
      }
    }
    return map
  }, [items, diffToolIds])

  const displayItems = useMemo(
    () =>
      items.filter((it) => {
        if (it.kind === 'tool') return diffToolIds.has(it.id)
        if (it.kind === 'message' && it.role !== 'user' && it.done && !it.text.trim()) {
          return (toolsByAgentMsgId.get(it.id)?.length ?? 0) > 0
        }
        return true
      }),
    [items, diffToolIds, toolsByAgentMsgId],
  )

  const hasPendingPrompt = useMemo(
    () => displayItems.some((it) => it.kind === 'prompt' && !it.resolved),
    [displayItems],
  )

  const typingStatus = useMemo((): 'thinking' | 'working' | undefined => {
    if (agentStatus !== 'idle') return agentStatus

    const hasStreaming = items.some(
      (it) => it.kind === 'message' && it.role === 'assistant' && !it.done && it.text.trim().length > 0,
    )
    if (hasStreaming) return undefined

    const hasInFlight = items.some(
      (it) =>
        (it.kind === 'tool' && !it.done) ||
        (it.kind === 'message' && it.role === 'assistant' && !it.done && it.text.trim().length === 0),
    )
    return hasInFlight ? 'working' : undefined
  }, [agentStatus, items])

  const { groupStartIds, dividerMap, daySeparators } = useMemo(() => {
    const groupStartIds = new Set<string>()
    const dividerMap = new Map<string, 'light' | 'heavy' | 'none'>()
    const daySeparators = new Map<string, string>()
    let prev: Item | undefined
    let prevTs: number | undefined
    for (let i = 0; i < displayItems.length; i++) {
      const cur = displayItems[i]
      const next = displayItems[i + 1]
      if (computeIsGroupStart(cur, prev)) groupStartIds.add(cur.id)
      dividerMap.set(cur.id, !next ? 'none' : senderRole(cur) !== senderRole(next) ? 'heavy' : 'light')
      const ts = cur.createdAt
      if (ts != null) {
        if (prevTs == null || !sameCalendarDay(prevTs, ts)) daySeparators.set(cur.id, formatDaySeparator(ts))
        prevTs = ts
      }
      prev = cur
    }
    return { groupStartIds, dividerMap, daySeparators }
  }, [displayItems])

  const newMessagesDividerId = useMemo(() => {
    if (unreadBaseline == null || openedAt == null) return null
    let hasReadBefore = false
    for (const it of displayItems) {
      const ts = it.createdAt
      if (ts == null) continue
      if (ts > unreadBaseline) {
        return ts <= openedAt && hasReadBefore ? it.id : null
      }
      hasReadBefore = true
    }
    return null
  }, [displayItems, unreadBaseline, openedAt])

  return {
    diffToolIds,
    toolsByAgentMsgId,
    displayItems,
    hasPendingPrompt,
    typingStatus,
    groupStartIds,
    dividerMap,
    daySeparators,
    newMessagesDividerId,
  }
}

function senderRole(item: Item): 'assistant' | 'user' | 'system' | null {
  return item.kind === 'message' || item.kind === 'file' ? item.role : null
}

function computeIsGroupStart(item: Item, prev: Item | undefined): boolean {
  const role = senderRole(item)
  if (role === null) return true
  if (!prev) return true
  return senderRole(prev) !== role
}
