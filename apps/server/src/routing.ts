/**
 * Webhook routing — pure predicates, no side effects (so they're unit-testable
 * without standing up the server).
 *
 * The server forwards each inbound ClientEvent to registered webhooks. Each
 * webhook may bind to a serverId (the agent it represents). We route by it so a
 * message for one agent isn't fanned out to every other agent's adapter.
 */

/**
 * Should a ClientEvent be delivered to a webhook?
 *
 * @param webhookServerId  serverId the webhook registered with (undefined = catch-all)
 * @param eventServerId    serverId the event targets (undefined = control event / legacy client)
 *
 * Rule: deliver unless BOTH name a server and they differ. A catch-all webhook
 * and a target-less event always pass, preserving older adapters and mobile
 * builds that don't stamp a serverId.
 */
export function shouldDeliverToWebhook(
  webhookServerId: string | undefined,
  eventServerId: string | undefined,
): boolean {
  if (webhookServerId !== undefined && eventServerId !== undefined) {
    return webhookServerId === eventServerId
  }
  return true
}
