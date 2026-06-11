const DEFAULT_SERVER_HOST = 'localhost'
const DEFAULT_SERVER_PORT = process.env.EXPO_PUBLIC_SERVER_PORT ?? '4000'
const SERVER_TOKEN = process.env.EXPO_PUBLIC_SERVER_TOKEN?.trim() || undefined

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
    if (SERVER_TOKEN) ws.searchParams.set('token', SERVER_TOKEN)

    const http = new URL(`http://${DEFAULT_SERVER_HOST}`)
    http.port = DEFAULT_SERVER_PORT

    return {
      isConfigured: false,
      hostLabel: `${DEFAULT_SERVER_HOST}:${DEFAULT_SERVER_PORT} (default)`,
      wsEndpoint: ws.toString(),
      httpBase: http.origin,
      token: SERVER_TOKEN,
    }
  }

  const parsed = normalizeRawHost(rawHost)
  const parsedProtocol = protocolFromUrl(parsed)
  const useSecure = parsedProtocol === 'https' || parsedProtocol === 'wss'
  const wsProtocol = useSecure ? 'wss' : 'ws'
  const httpProtocol = useSecure ? 'https' : 'http'
  // For secure URLs (e.g. Cloudflare tunnel) with no explicit port, don't
  // append a default — they terminate TLS at 443 and don't expose 4000.
  const port = parsed.port || (useSecure ? '' : DEFAULT_SERVER_PORT)

  const ws = new URL(`${wsProtocol}://${parsed.hostname}`)
  if (port) ws.port = port
  ws.pathname = '/ws'
  if (SERVER_TOKEN) ws.searchParams.set('token', SERVER_TOKEN)

  const http = new URL(`${httpProtocol}://${parsed.hostname}`)
  if (port) http.port = port

  return {
    isConfigured: true,
    hostLabel: port ? `${parsed.hostname}:${port}` : parsed.hostname,
    wsEndpoint: ws.toString(),
    httpBase: http.origin,
    token: SERVER_TOKEN,
  }
}

export const SERVER_CONFIG = getServerConfig()