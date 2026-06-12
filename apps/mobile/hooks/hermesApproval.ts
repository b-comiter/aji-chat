import type { Item } from './chatTypes'

const HERMES_APPROVAL_RE = /Reply\s+`\/approve`\s+to execute/

export function tryApprovalPrompt(
  msg: Extract<Item, { kind: 'message' }>,
): Extract<Item, { kind: 'prompt' }> | null {
  if (msg.role !== 'assistant' || !HERMES_APPROVAL_RE.test(msg.text)) return null

  // Extract command and reason from Hermes text payload.
  const cmdMatch = msg.text.match(/```[^\n]*\n([\s\S]+?)\n```/)
  const command = cmdMatch?.[1]?.trim()
  const reasonMatch = msg.text.match(/Reason:\s*(.+)/)
  const reason = reasonMatch?.[1]?.trim()

  // Keep shape compatible with parsePermissionMessage.
  const messageBody = JSON.stringify({
    ...(command ? { command } : {}),
    ...(reason ? { description: reason } : {}),
  })

  return {
    kind: 'prompt',
    id: msg.id,
    title: 'Command requires approval',
    message: `Hermes is requesting permission to run a command.\n\n${messageBody}`,
    options: [
      { id: '/approve', label: 'Approve once' },
      { id: '/approve session', label: 'Approve for session' },
      { id: '/approve always', label: 'Always approve' },
      { id: '/deny', label: 'Deny' },
    ],
    turnId: msg.turnId,
  }
}
