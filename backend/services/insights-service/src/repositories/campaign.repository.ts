/**
 * The campaigns copy (analytics.campaigns, kept by ingestion-service from the
 * retail API), read for seller-manager access and seller totals. Every read names
 * its tenant, which the reader user's row policy enforces.
 */
import type { ClickHouse } from '@basketline/platform/clickhouse'
import { tenantRead } from './metrics.repository.ts'

/** A campaign's seller, if the campaign is the tenant's (undefined: no such campaign; null: sent before sellers). */
export async function findCampaignSeller(clickhouse: ClickHouse, tenantId: string, campaignId: string): Promise<string | null | undefined> {
  const result = await clickhouse.query({
    query: `SELECT toString(argMax(seller_id, version)) AS seller FROM campaigns
            WHERE campaign_id = {campaignId:UUID} AND tenant_id = {tenantId:UUID} GROUP BY campaign_id`,
    query_params: { campaignId, tenantId },
    clickhouse_settings: tenantRead(tenantId),
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
    clickhouse_settings: tenantRead(tenantId),
    format: 'JSONEachRow',
  })
  return (await result.json<{ id: string }>()).map((row) => row.id)
}
