import type { ClickHouse } from '@basketline/platform/clickhouse'

/** The tenant's active campaigns (analytics.campaigns, loaded from the retail API's campaign topic), by ID. */
export async function activeCampaignIds(clickhouse: ClickHouse, tenantId: string): Promise<Set<string>> {
  const result = await clickhouse.query({
    query: `SELECT toString(campaign_id) AS id FROM campaigns FINAL
            WHERE tenant_id = {tenantId:UUID} AND status = 'active' AND NOT archived`,
    query_params: { tenantId },
    format: 'JSONEachRow',
  })
  return new Set((await result.json<{ id: string }>()).map((row) => row.id))
}
