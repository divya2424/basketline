import type { AnalyticsEventPayload, EventEnvelope } from '@basketline/contracts'
import type { ClickHouse } from '../clickhouse.ts'

/** Raw tables holding a shopper's rows. Daily totals hold no user IDs (counts and sketches). */
const USER_TABLES = ['events', 'attributed_baskets', 'sessions']

/**
 * Erasure (user_deleted, retail.identity-events.v1): records the shopper as
 * deleted (the archive purge job deletes their archived rows), then deletes their
 * rows here. Lightweight deletes: hidden at once, removed by the next merges.
 * Other identity events are stored by the Flink job like interactions.
 */
export async function handleIdentityEvent(clickhouse: ClickHouse, envelope: EventEnvelope): Promise<void> {
  const event = envelope.payload as AnalyticsEventPayload
  if (event.eventName !== 'user_deleted') return
  await clickhouse.insert({
    table: 'deleted_users',
    format: 'JSONEachRow',
    values: [{ tenant_id: event.tenantId, user_id: event.userId, deleted_at: event.receivedAt.replace('T', ' ').replace('Z', '') }],
  })
  for (const table of USER_TABLES) {
    await clickhouse.command({
      query: `DELETE FROM ${table} WHERE tenant_id = {tenantId:UUID} AND user_id = {userId:UUID}`,
      query_params: { tenantId: event.tenantId, userId: event.userId },
    })
  }
}
