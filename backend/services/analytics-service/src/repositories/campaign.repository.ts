/**
 * analytics.campaigns: this service's copy of each campaign's status, kept up to
 * date from campaign.v1 events. ReplacingMergeTree(version) keeps the newest
 * version, so replays and out-of-order events are harmless.
 */
import type { CampaignState } from '@ecommerce-analytics/contracts'
import type { ClickHouse } from '../clickhouse.ts'

export async function upsertCampaignState(clickhouse: ClickHouse, campaign: CampaignState, version: number): Promise<void> {
  await clickhouse.insert({
    table: 'campaigns',
    format: 'JSONEachRow',
    values: [{ campaign_id: campaign.campaignId, tenant_id: campaign.tenantId, status: campaign.status, archived: campaign.archived, version }],
  })
}

/** The IDs among `ids` that belong to the tenant and whose newest version is active and not archived. */
export async function findActiveCampaigns(clickhouse: ClickHouse, tenantId: string, ids: string[]): Promise<Set<string>> {
  const result = await clickhouse.query({
    query: `SELECT toString(campaign_id) AS id FROM campaigns
            WHERE campaign_id IN {ids:Array(UUID)} AND tenant_id = {tenantId:UUID}
            GROUP BY campaign_id
            HAVING argMax(status, version) = 'active' AND NOT argMax(archived, version)`,
    query_params: { ids, tenantId },
    format: 'JSONEachRow',
  })
  return new Set((await result.json<{ id: string }>()).map((row) => row.id))
}
