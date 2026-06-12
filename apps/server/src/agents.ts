import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'hono'
import { loadJson, saveJson } from './persist'

export interface AgentRecord { agentId: string; name: string; firstSeen: number; lastSeen: number }

const AGENTS_FILE = process.env.AJI_DATA_DIR
  ? join(process.env.AJI_DATA_DIR, 'agents.json')
  : join(homedir(), '.aji-chat', 'agents.json')

const agentsByToken = new Map<string, AgentRecord>()

export function loadAgents(): void {
  const obj = loadJson<Record<string, AgentRecord>>(AGENTS_FILE)
  if (obj) for (const [token, rec] of Object.entries(obj)) agentsByToken.set(token, rec)
}

export function saveAgents(): void {
  const obj: Record<string, AgentRecord> = {}
  for (const [token, rec] of agentsByToken) obj[token] = rec
  saveJson(AGENTS_FILE, obj)
}

export function bearerToken(c: Context): string | undefined {
  const h = c.req.header('authorization')
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null
  return m ? m[1] : undefined
}

/** Resolve a bearer token to its agentId (touches lastSeen). Undefined if unknown. */
export function agentIdForToken(token: string | undefined): string | undefined {
  if (!token) return undefined
  const rec = agentsByToken.get(token)
  if (!rec) return undefined
  rec.lastSeen = Date.now()
  return rec.agentId
}

/** Look up a record by token for mutation. Undefined if unknown. */
export function getAgentRecord(token: string): AgentRecord | undefined {
  return agentsByToken.get(token)
}

export function hasToken(token: string): boolean {
  return agentsByToken.has(token)
}

/** Mint a new agent identity and persist it. Returns the new token and agentId. */
export function mintAgent(name: string): { token: string; agentId: string } {
  const token = randomUUID().replace(/-/g, '')
  const agentId = `agent_${randomUUID().slice(0, 8)}`
  agentsByToken.set(token, { agentId, name, firstSeen: Date.now(), lastSeen: Date.now() })
  saveAgents()
  return { token, agentId }
}
