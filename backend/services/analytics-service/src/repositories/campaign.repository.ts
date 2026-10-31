/**
 * analytics.campaigns: this service's copy of each campaign (tenant, seller,
 * status), from retail.campaign-events.v1. ReplacingMergeTree(version) keeps the
 * newest version, so replays and out-of-order events are harmless.
 */
import type { ReferenceEventPayload } from '@basketline/contracts'
import type { ClickHouse } from '../clickhouse.ts'

export async function upsertCampaign(clickhouse: ClickHouse, campaign: ReferenceEventPayload<'campaign_upserted'>, version: number, issues: string[]): Promise<void> {
  await clickhouse.insert({
    table: 'campaigns',
    format: 'JSONEachRow',
    values: [{
      campaign_id: campaign.campaignId,
      tenant_id: campaign.tenantId,
      seller_id: campaign.sellerId,
      status: campaign.status,
      archived: campaign.archived,
      issues,
      version,
    }],
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

/** A campaign's seller, if the campaign is the tenant's (undefined: no such campaign; null: sent before sellers). */
export async function findCampaignSeller(clickhouse: ClickHouse, tenantId: string, campaignId: string): Promise<string | null | undefined> {
  const result = await clickhouse.query({
    query: `SELECT toString(argMax(seller_id, version)) AS seller FROM campaigns
            WHERE campaign_id = {campaignId:UUID} AND tenant_id = {tenantId:UUID} GROUP BY campaign_id`,
    query_params: { campaignId, tenantId },
    format: 'JSONEachRow',
  })
  const [row] = await result.json<{ seller: string | null }>()
  return row === undefined ? undefined : row.seller
}

/** The tenant's campaigns of one seller. */
export async function findSellerCampaigns(clickhouse: ClickHouse, tenantId: string, sellerId: string): Promise<string[]> {
  const result = await clickhouse.query({
    query: `SELECT toString(campaign_id) AS id FROM campaigns WHERE tenant_id = {tenantId:UUID}
            GROUP BY campaign_id HAVING argMax(seller_id, version) = {sellerId:UUID}`,
    query_params: { tenantId, sellerId },
    format: 'JSONEachRow',
  })
  return (await result.json<{ id: string }>()).map((row) => row.id)
}
