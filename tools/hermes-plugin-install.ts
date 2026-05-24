/**
 * Install the aji-chat Hermes plugin.
 *
 * Symlinks <repo>/tools/hermes-plugin to ~/.hermes/plugins/aji-chat so the
 * Hermes gateway picks up the plugin at next startup. Idempotent: if the
 * symlink already points at this repo's plugin directory, re-running is a
 * no-op. If a different file/directory exists at the target, refuses to
 * overwrite and prints how to remove it.
 *
 * Usage:  pnpm hermes:install
 * Undo:   pnpm hermes:uninstall
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_SRC = path.resolve(__dirname, 'hermes-plugin')
const HERMES_HOME = process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes')
const PLUGINS_DIR = path.join(HERMES_HOME, 'plugins')
const TARGET = path.join(PLUGINS_DIR, 'aji-chat')

function install(): void {
  // Pre-flight: plugin source must exist
  if (!fs.existsSync(PLUGIN_SRC)) {
    console.error(`✗ Plugin source not found: ${PLUGIN_SRC}`)
    process.exit(1)
  }

  // Warn if Hermes isn't installed (no ~/.hermes) — still create the dirs and
  // proceed; the user might install Hermes after.
  if (!fs.existsSync(HERMES_HOME)) {
    console.warn(`! ${HERMES_HOME} does not exist — is Hermes installed?`)
    console.warn(`  Creating it anyway so the plugin is ready when you install Hermes.`)
  }
  fs.mkdirSync(PLUGINS_DIR, { recursive: true })

  // If TARGET already exists, decide what to do based on whether it's the
  // symlink we'd create.
  if (fs.existsSync(TARGET) || fs.lstatSync(TARGET, { throwIfNoEntry: false })) {
    const stat = fs.lstatSync(TARGET)
    if (stat.isSymbolicLink()) {
      const current = fs.readlinkSync(TARGET)
      const currentAbs = path.isAbsolute(current) ? current : path.resolve(PLUGINS_DIR, current)
      if (currentAbs === PLUGIN_SRC) {
        console.log(`✓ Already installed: ${TARGET} → ${PLUGIN_SRC}`)
        return
      }
      console.error(`✗ ${TARGET} is a symlink to a different path:`)
      console.error(`    ${currentAbs}`)
      console.error(`  Remove it first:  rm ${TARGET}`)
      process.exit(1)
    } else {
      console.error(`✗ ${TARGET} already exists and is not a symlink.`)
      console.error(`  Remove it first (back it up if needed):  rm -rf ${TARGET}`)
      process.exit(1)
    }
  }

  fs.symlinkSync(PLUGIN_SRC, TARGET, 'dir')
  console.log(`✓ Installed aji-chat plugin`)
  console.log(`  ${TARGET}`)
  console.log(`  → ${PLUGIN_SRC}`)
  console.log()
  console.log(`Next:`)
  console.log(`  export AJI_SERVER_URL=http://localhost:4000`)
  console.log(`  pnpm server      # start aji-chat server`)
  console.log(`  hermes gateway   # picks up the plugin`)
  console.log()
  console.log(`Undo:  pnpm hermes:uninstall`)
}

install()
