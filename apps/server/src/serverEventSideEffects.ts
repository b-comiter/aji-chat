import type { Commands, PermissionRequest, ServerEvent, ServerInfo } from '@aji/protocol'

type Params = {
  event: ServerEvent
  commandsCache: Map<string, Commands>
  serverInfoCache: Map<string, ServerInfo>
  saveServerInfo: () => void
  logPermissionRequest: (event: PermissionRequest) => void
}

export function applyServerEventSideEffects({
  event,
  commandsCache,
  serverInfoCache,
  saveServerInfo,
  logPermissionRequest,
}: Params): void {
  if (event.type === 'commands') {
    commandsCache.set(event.serverId ?? '__global__', event)
    return
  }

  if (event.type === 'server_info') {
    serverInfoCache.set(event.serverId, event)
    saveServerInfo()
    return
  }

  if (event.type === 'permission_request') {
    logPermissionRequest(event)
  }
}
