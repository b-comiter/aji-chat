const DEFAULT_SERVER_HOST = 'localhost'
const DEFAULT_SERVER_PORT = process.env.EXPO_PUBLIC_SERVER_PORT ?? '4000'

type SupportedProtocol = 'http' | 'https' | 'ws' | 'wss'

function isSupportedProtocol(value: string): value is SupportedProtocol {
  return value === 'http' || value === 'https' || value === 'ws' || value === 'wss'
}

function normalizeRawHost(rawHost: string): URL {
  const withScheme = /^(https?|wss?):\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`
  return new URL(withScheme)
}

function protocolFromUrl(url: URL): SupportedProtocol {
  const protocol = url.protocol.replace(':', '')
  return isSupportedProtocol(protocol) ? protocol : 'http'
}

export function getServerConfig() {
  const rawHost = process.env.EXPO_PUBLIC_SERVER_HOST?.trim()

  if (!rawHost) {
    const ws = new URL(`ws://${DEFAULT_SERVER_HOST}`)
    ws.port = DEFAULT_SERVER_PORT
    ws.pathname = '/ws'

    const http = new URL(`http://${DEFAULT_SERVER_HOST}`)
    http.port = DEFAULT_SERVER_PORT

    return {
      isConfigured: false,
      hostLabel: `${DEFAULT_SERVER_HOST}:${DEFAULT_SERVER_PORT} (default)`,
      wsEndpoint: ws.toString(),
      httpBase: http.origin,
    }
  }

  const parsed = normalizeRawHost(rawHost)
  const parsedProtocol = protocolFromUrl(parsed)
  const useSecure = parsedProtocol === 'https' || parsedProtocol === 'wss'
  const wsProtocol = useSecure ? 'wss' : 'ws'
  const httpProtocol = useSecure ? 'https' : 'http'
  const port = parsed.port || DEFAULT_SERVER_PORT

  const ws = new URL(`${wsProtocol}://${parsed.hostname}`)
  ws.port = port
  ws.pathname = '/ws'

  const http = new URL(`${httpProtocol}://${parsed.hostname}`)
  http.port = port

  return {
    isConfigured: true,
    hostLabel: `${parsed.hostname}:${port}`,
    wsEndpoint: ws.toString(),
    httpBase: http.origin,
  }
}

export const SERVER_CONFIG = getServerConfig()