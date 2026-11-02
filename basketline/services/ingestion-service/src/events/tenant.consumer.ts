import type { EventEnvelope, EventPayloads } from '@basketline/contracts'
import type { ClickHouse } from '@basketline/platform/clickhouse'
import { deleteTenantData } from '../repositories/tenant.repository.ts'

/** auth.tenant.v1: a deleted tenant (TenantDeleted), whose analytics all go. */
export async function handleTenantEvent(clickhouse: ClickHouse, envelope: EventEnvelope): Promise<void> {
  if (envelope.eventType === 'TenantDeleted') await deleteTenantData(clickhouse, envelope.payload as EventPayloads['TenantDeleted'])
}
