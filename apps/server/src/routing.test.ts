import { shouldDeliverToWebhook } from './routing'

describe('shouldDeliverToWebhook', () => {
  test('delivers when webhook serverId matches the event target', () => {
    expect(shouldDeliverToWebhook('hermes', 'hermes')).toBe(true)
  })

  test('drops when webhook serverId differs from the event target', () => {
    expect(shouldDeliverToWebhook('hermes', 'claude-code')).toBe(false)
    expect(shouldDeliverToWebhook('claude-code', 'hermes')).toBe(false)
  })

  test('catch-all webhook (no serverId) receives every event', () => {
    expect(shouldDeliverToWebhook(undefined, 'hermes')).toBe(true)
    expect(shouldDeliverToWebhook(undefined, 'claude-code')).toBe(true)
    expect(shouldDeliverToWebhook(undefined, undefined)).toBe(true)
  })

  test('target-less event (control event / legacy client) reaches every webhook', () => {
    // prompt_response / get_commands / get_missed_events carry no serverId, and
    // older mobile builds may omit it on user_message — both must still fan out.
    expect(shouldDeliverToWebhook('hermes', undefined)).toBe(true)
    expect(shouldDeliverToWebhook('claude-code', undefined)).toBe(true)
  })
})
