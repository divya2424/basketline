import type { EventEnvelope, EventPayloads } from '@basketline/contracts'
import type { ClickHouse } from '../clickhouse.ts'
import { deleteTenantData } from '../repositories/tenant.repository.ts'

/** A deleted tenant (TenantDeleted, auth.tenant.v1): all of its analytics go. */
export async function handleTenantEvent(clickhouse: ClickHouse, envelope: EventEnvelope): Promise<void> {
  if (envelope.eventType !== 'TenantDeleted') return
  await deleteTenantData(clickhouse, envelope.payload as EventPayloads['TenantDeleted'])
}
