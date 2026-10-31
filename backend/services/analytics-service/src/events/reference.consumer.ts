import type { EventEnvelope, ReferenceEventPayload } from '@basketline/contracts'
import type { ClickHouse } from '../clickhouse.ts'
import { upsertCampaign } from '../repositories/campaign.repository.ts'
import { findProduct, findProductSellers, upsertProduct, upsertSeller } from '../repositories/product.repository.ts'

/**
 * Applies the retailer's reference data (retail.catalog-events.v1 and
 * retail.campaign-events.v1) to this service's copies. The envelope's
 * aggregateVersion is the state's updatedAt, so the newest state wins.
 */
export async function handleReferenceEvent(clickhouse: ClickHouse, envelope: EventEnvelope): Promise<void> {
  const version = envelope.aggregateVersion
  switch (envelope.eventType) {
    case 'seller_upserted':
      return upsertSeller(clickhouse, envelope.payload as ReferenceEventPayload<'seller_upserted'>, version)
    case 'product_upserted':
      return upsertProduct(clickhouse, envelope.payload as ReferenceEventPayload<'product_upserted'>, version)
    case 'product_removed': {
      const { tenantId, productId } = envelope.payload as ReferenceEventPayload<'product_removed'>
      const product = await findProduct(clickhouse, tenantId, productId)
      // Kept, marked removed: its events keep their seller. Unknown products need nothing.
      if (product) await upsertProduct(clickhouse, product, version, true)
      return
    }
    case 'campaign_upserted': {
      const campaign = envelope.payload as ReferenceEventPayload<'campaign_upserted'>
      return upsertCampaign(clickhouse, campaign, version, await campaignIssues(clickhouse, campaign))
    }
    case 'campaign_removed': {
      // A removed campaign is archived: it no longer counts, and its numbers stay.
      const { tenantId, campaignId } = envelope.payload as ReferenceEventPayload<'campaign_removed'>
      await clickhouse.command({
        query: `INSERT INTO campaigns (campaign_id, tenant_id, seller_id, status, archived, issues, version)
                SELECT campaign_id, tenant_id, argMax(seller_id, version), argMax(status, version), true, argMax(issues, version), {version:UInt64}
                FROM campaigns WHERE campaign_id = {campaignId:UUID} AND tenant_id = {tenantId:UUID} GROUP BY campaign_id, tenant_id
                HAVING max(version) < {version:UInt64}`,
        query_params: { campaignId, tenantId, version },
      })
      return
    }
    default:
      return
  }
}

/** What is wrong with a campaign's products: kept and flagged, not refused (the catalog may arrive later). */
async function campaignIssues(clickhouse: ClickHouse, campaign: ReferenceEventPayload<'campaign_upserted'>): Promise<string[]> {
  if (campaign.productIds.length === 0) return []
  const sellers = await findProductSellers(clickhouse, campaign.tenantId, campaign.productIds)
  return campaign.productIds.flatMap((id) => {
    const seller = sellers.get(id)
    if (seller === undefined) return [`product ${id} isn't in the catalog yet`]
    return seller === campaign.sellerId ? [] : [`product ${id} belongs to another seller`]
  })
}
