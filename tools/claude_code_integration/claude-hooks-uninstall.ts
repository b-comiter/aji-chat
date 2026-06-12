/**
 * Uninstall aji-chat hooks from Claude Code's global settings.
 *
 * Removes every hook entry from ~/.claude/settings.json whose command contains
 * the `claude-aji-chat-hook` marker. Leaves all other settings untouched.
 * Cleans up empty arrays / `hooks` block when nothing else lives there.
 *
 * Usage: pnpm hooks:uninstall
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const MARKER = 'claude-aji-chat-hook'

interface HookCommand { type: string; command: string }
interface HookEntry { matcher?: string; hooks: HookCommand[] }
interface Settings { hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

function readSettings(): Settings {
  if (!fs.existsSync(SETTINGS_PATH)) return {}
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as Settings }
  catch { return {} }
}

function writeSettings(s: Settings): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + '\n')
}

function isOurEntry(entry: HookEntry): boolean {
  return entry.hooks?.some((h) => h.command?.includes(MARKER)) ?? false
}

function uninstall(): void {
  if (!fs.existsSync(SETTINGS_PATH)) {
    console.log(`No settings file at ${SETTINGS_PATH} — nothing to remove.`)
    return
  }

  const settings = readSettings()
  if (!settings.hooks) {
    console.log('No hooks configured — nothing to remove.')
    return
  }

  let removed = 0
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length
    settings.hooks[event] = settings.hooks[event].filter((e) => !isOurEntry(e))
    removed += before - settings.hooks[event].length
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks

  writeSettings(settings)
  console.log(`✓ Removed ${removed} aji-chat hook ${removed === 1 ? 'entry' : 'entries'} from ${SETTINGS_PATH}`)
}

uninstall()
