/**
 * The tenant's campaigns, as the daily aggregates know them: every (campaign,
 * store) with activity, newest first. Basketline keeps no campaign records (they
 * go to the data lake), so campaigns are listed by ID. Every read names its
 * tenant, which the reader user's row policy enforces.
 */
import type { ClickHouse } from '@basketline/platform/clickhouse'
import { tenantRead } from './metrics.repository.ts'

export interface CampaignSummary {
  id: string
  storeId: string
  /** The last day it had activity (YYYY-MM-DD, UTC). */
  lastDay: string
}

export async function listCampaigns(clickhouse: ClickHouse, tenantId: string): Promise<CampaignSummary[]> {
  const result = await clickhouse.query({
    query: `SELECT toString(campaign_id) AS id, toString(store_id) AS storeId, toString(max(day)) AS lastDay
            FROM daily_campaign_aggregation WHERE tenant_id = {tenantId:UUID}
            GROUP BY campaign_id, store_id
            ORDER BY lastDay DESC, id, storeId`,
    query_params: { tenantId },
    clickhouse_settings: tenantRead(tenantId),
    format: 'JSONEachRow',
  })
  return result.json<CampaignSummary>()
}
