/**
 * Uninstall the aji-chat Hermes plugin.
 *
 * Removes ~/.hermes/plugins/aji-chat *only* if it's a symlink pointing into
 * this repo. Refuses to remove a plain directory or a symlink that points
 * elsewhere — a user may have manually installed something different there.
 *
 * Usage: pnpm hermes:uninstall
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_SRC = path.resolve(__dirname, 'hermes-plugin')
const HERMES_HOME = process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes')
const TARGET = path.join(HERMES_HOME, 'plugins', 'aji-chat')

function uninstall(): void {
  if (!fs.lstatSync(TARGET, { throwIfNoEntry: false })) {
    console.log(`Nothing to remove: ${TARGET} does not exist.`)
    return
  }

  const stat = fs.lstatSync(TARGET)
  if (!stat.isSymbolicLink()) {
    console.error(`✗ ${TARGET} is not a symlink. Refusing to delete a real directory.`)
    console.error(`  If you really want to remove it:  rm -rf ${TARGET}`)
    process.exit(1)
  }

  const current = fs.readlinkSync(TARGET)
  const currentAbs = path.isAbsolute(current) ? current : path.resolve(path.dirname(TARGET), current)
  if (currentAbs !== PLUGIN_SRC) {
    console.error(`✗ ${TARGET} points to ${currentAbs}, not this repo's plugin.`)
    console.error(`  Refusing to remove someone else's symlink.`)
    console.error(`  If you want to remove it anyway:  rm ${TARGET}`)
    process.exit(1)
  }

  fs.unlinkSync(TARGET)
  console.log(`✓ Removed ${TARGET}`)
}

uninstall()
