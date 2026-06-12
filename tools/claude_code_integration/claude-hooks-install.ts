/**
 * Install aji-chat hooks into Claude Code's global settings.
 *
 * Adds entries to ~/.claude/settings.json that invoke tools/claude-aji-chat-hook.ts
 * on UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, and Stop.
 * Idempotent: re-running just refreshes the entries. Removes any prior
 * aji-chat hook entries (matched by the `claude-aji-chat-hook` substring in
 * their command) before adding fresh ones.
 *
 * Usage:  pnpm claude-hook:install
 * Undo:   pnpm claude-hook:uninstall
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop'] as const

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TSX = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx')
const HOOK = path.resolve(__dirname, 'claude-aji-chat-hook.ts')
const MARKER = 'claude-aji-chat-hook'
const COMMAND = `${TSX} ${HOOK}`

interface HookCommand { type: string; command: string }
interface HookEntry { matcher?: string; hooks: HookCommand[] }
interface Settings { hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

function readSettings(): Settings {
  if (!fs.existsSync(SETTINGS_PATH)) return {}
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as Settings }
  catch { return {} }
}

function writeSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + '\n')
}

function isOurEntry(entry: HookEntry): boolean {
  return entry.hooks?.some((h) => h.command?.includes(MARKER)) ?? false
}

function install(): void {
  // Pre-flight: make sure tsx and the hook script both exist
  for (const p of [TSX, HOOK]) {
    if (!fs.existsSync(p)) {
      console.error(`✗ Missing required file: ${p}`)
      process.exit(1)
    }
  }

  const settings = readSettings()
  settings.hooks ??= {}

  for (const event of HOOK_EVENTS) {
    settings.hooks[event] ??= []
    settings.hooks[event] = settings.hooks[event].filter((e) => !isOurEntry(e))
    settings.hooks[event].push({
      matcher: '*',
      hooks: [{ type: 'command', command: COMMAND }],
    })
  }

  writeSettings(settings)
  console.log(`✓ Installed aji-chat hooks → ${SETTINGS_PATH}`)
  console.log(`  Events: ${HOOK_EVENTS.join(', ')}`)
  console.log(`  Command: ${COMMAND}`)
  console.log()
  console.log(`Next: run \`pnpm server\` and start a Claude Code session.`)
  console.log(`Undo: \`pnpm claude-hook:uninstall\``)
}

install()
