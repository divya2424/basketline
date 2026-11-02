import type { ClickHouse } from '../clickhouse.ts'

/** Every table with a tenant's rows: raw, daily, sessions, reference data and counts. */
const TENANT_TABLES = [
  'events',
  'attributed_baskets',
  'sessions',
  'daily_campaign_aggregation',
  'daily_campaign_customers_aggregation',
  'daily_campaign_sessions_aggregation',
  'campaigns',
  'sellers',
  'products',
  'invalid_traffic_daily',
  'deleted_users',
  'tenants',
]

/** The tenant's account tier (TenantOnboarded), which sizes its ingestion budget. */
export async function upsertTenantTier(clickhouse: ClickHouse, tenant: { tenantId: string; tier: string }, version: number) {
  await clickhouse.insert({ table: 'tenants', values: [{ tenant_id: tenant.tenantId, tier: tenant.tier, version }], format: 'JSONEachRow' })
}

/** The tenant's tier, or null before its TenantOnboarded arrived. */
export async function findTenantTier(clickhouse: ClickHouse, tenantId: string): Promise<string | null> {
  const result = await clickhouse.query({
    query: 'SELECT argMax(tier, version) AS tier FROM tenants WHERE tenant_id = {tenantId:UUID} GROUP BY tenant_id',
    query_params: { tenantId },
    format: 'JSONEachRow',
  })
  const [row] = await result.json<{ tier: string }>()
  return row?.tier ?? null
}

/**
 * Records the tenant as deleted first (so the Kafka queue views drop any of its
 * rows from now on), then deletes its rows everywhere. Lightweight deletes:
 * rows are hidden at once and removed by the next merges. Safe to repeat.
 */
export async function deleteTenantData(clickhouse: ClickHouse, tenant: { tenantId: string; name: string; deletedAt: string }) {
  await clickhouse.insert({
    table: 'deleted_tenants',
    values: [{ tenant_id: tenant.tenantId, name: tenant.name, deleted_at: tenant.deletedAt.replace('T', ' ').replace('Z', '') }],
    format: 'JSONEachRow',
  })
  for (const table of TENANT_TABLES) {
    await clickhouse.command({ query: `DELETE FROM ${table} WHERE tenant_id = {tenantId:UUID}`, query_params: { tenantId: tenant.tenantId } })
  }
}
