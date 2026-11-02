import type { EventEnvelope, EventPayloads } from '@basketline/contracts'
import type { ClickHouse } from '@basketline/platform/clickhouse'
import { deleteTenantData, upsertTenantTier } from '../repositories/tenant.repository.ts'

/**
 * auth.tenant.v1: an onboarded tenant's tier (TenantOnboarded), which sizes its
 * ingestion budget; a deleted tenant (TenantDeleted), whose analytics all go.
 */
export async function handleTenantEvent(clickhouse: ClickHouse, envelope: EventEnvelope): Promise<void> {
  if (envelope.eventType === 'TenantOnboarded') {
    await upsertTenantTier(clickhouse, envelope.payload as EventPayloads['TenantOnboarded'], Date.parse(envelope.occurredAt))
  } else if (envelope.eventType === 'TenantDeleted') {
    await deleteTenantData(clickhouse, envelope.payload as EventPayloads['TenantDeleted'])
  }
}
