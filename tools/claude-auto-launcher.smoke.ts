/**
 * Isolated smoke test for the auto-launcher's pure logic.
 *
 * Verifies — with no side effects, no server, and no Terminal windows — the
 * three pieces that carry the risk:
 *   1. shouldLaunch routing predicate (mirrors the bridge's shouldForward)
 *   2. buildLaunchCommand: contains the channel flag + uses the safe "$(cat …)"
 *      form so arbitrary message text needs no escaping
 *   3. buildTerminalAppleScript: escapes backslashes and double quotes
 *
 * The webhook receiver / registration / pgrep / osascript paths are identical in
 * shape to the channel bridge (verified there + manually end-to-end).
 *
 * Run: pnpm autolaunch:smoke
 */
import type { ClientEvent } from '@aji/protocol'

// Set BEFORE importing the module: its top-level `main()` guard reads this, and
// a static import would be hoisted above the assignment — so import dynamically.
process.env.AJI_LAUNCHER_TEST = '1'
const { shouldLaunch, buildLaunchCommand, buildTerminalAppleScript, tmuxSessionFor } = await import('./claude-auto-launcher.ts')

const failures: string[] = []
function check(label: string, cond: boolean): void {
  if (!cond) failures.push(label)
}

// 1. Routing predicate
check('user_message for our agent → launch',
  shouldLaunch({ type: 'user_message', text: 'hi', serverId: 'claude-code' } as ClientEvent, 'claude-code'))
check('user_message with no serverId → launch (back-compat)',
  shouldLaunch({ type: 'user_message', text: 'hi' } as ClientEvent, 'claude-code'))
check('user_message for another agent → NO launch',
  !shouldLaunch({ type: 'user_message', text: 'hi', serverId: 'hermes' } as ClientEvent, 'claude-code'))
check('non-message event → NO launch',
  !shouldLaunch({ type: 'get_commands' } as ClientEvent, 'claude-code'))

// 2. Launch command
const cmd = buildLaunchCommand({
  cwd: '/Users/me/dev/aji-chat',
  claudeBin: 'claude',
  promptFile: '/tmp/aji-cc-initial-123.txt',
  channel: 'feature-x',
})
check('launch cmd exports the channel for the hook + bridge', cmd.includes('export AJI_CHANNEL="feature-x"'))
check('launch cmd cds into the channel cwd', cmd.includes('cd "/Users/me/dev/aji-chat"'))
check('launch cmd carries the channel flag', cmd.includes('--dangerously-load-development-channels server:aji-chat'))
// The `--` must sit between the variadic flag and the prompt, or claude treats
// the prompt as an untagged channel entry and exits.
check('launch cmd isolates prompt with --', cmd.includes('server:aji-chat -- "$(cat'))
check('launch cmd reads prompt via "$(cat …)"', cmd.includes('"$(cat "/tmp/aji-cc-initial-123.txt")"'))
// On failure (bad cwd, claude missing) keep the pane open instead of vanishing.
check('launch cmd keeps the pane open on failure', cmd.includes('|| exec zsh -l'))

// 2b. Per-channel tmux session naming (tmux-safe: no '.' or ':')
check('session name prefixes the channel', tmuxSessionFor('feature-x') === 'aji-cc-feature-x')
check('session name defaults blank channel to general', tmuxSessionFor('') === 'aji-cc-general')
check('session name strips tmux-unsafe dots', tmuxSessionFor('v1.2') === 'aji-cc-v1_2')

// 3. AppleScript escaping
const script = buildTerminalAppleScript('echo "hi" \\ there')
check('applescript opens Terminal', script.includes('tell application "Terminal"'))
check('applescript escapes double quotes', script.includes('echo \\"hi\\"'))
check('applescript escapes backslashes', script.includes('\\\\ there'))

if (failures.length > 0) {
  console.error('SMOKE FAILED:\n  - ' + failures.join('\n  - '))
  process.exit(1)
}
console.log('✓ SMOKE PASSED — routing, launch command, and AppleScript escaping all correct')
process.exit(0)
