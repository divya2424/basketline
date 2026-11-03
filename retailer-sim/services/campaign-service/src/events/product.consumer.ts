import type { EventEnvelope } from '@basketline/contracts'
import type { BasketlineSender, RetailerEventPayloads } from '@retailer-sim/shared'
import type { DbOrTx } from '../db/client.ts'
import { listCampaignsWithProduct } from '../repositories/campaign.repository.ts'
import { markProductInactive, upsertProductState } from '../repositories/product.repository.ts'
import { basketlineCampaignProducts } from '../services/campaign.service.ts'

/**
 * Applies product.v1 events to the local products copy. A created or updated
 * product goes to Basketline again in each campaign it is in, with its details as
 * the copy now has them (a stale event sends the newer details it didn't apply).
 */
export async function handleProductEvent(db: DbOrTx, envelope: EventEnvelope, basketline?: BasketlineSender): Promise<void> {
  // Events from before products had tenants: the product's next change counts.
  if (!(envelope.payload as { tenantId?: string }).tenantId) return
  switch (envelope.eventType) {
    case 'ProductCreated':
    case 'ProductUpdated': {
      const product = envelope.payload as RetailerEventPayloads['ProductCreated']
      await upsertProductState(db, product, envelope.aggregateVersion)
      const campaigns = await listCampaignsWithProduct(db, product.tenantId, product.productId)
      const added = (await Promise.all(campaigns.map((campaignId) => basketlineCampaignProducts(db, product.tenantId, campaignId, [product.productId])))).flat()
      if (added.length > 0) await basketline?.send(product.tenantId, (server) => server.campaigns.addProducts(added))
      return
    }
    case 'ProductDeactivated': {
      const { productId, tenantId, deactivatedAt, deactivatedBy } = envelope.payload as RetailerEventPayloads['ProductDeactivated']
      await markProductInactive(db, productId, tenantId, envelope.aggregateVersion, deactivatedAt, deactivatedBy ?? null)
      return
    }
    default:
      // Event types this service doesn't need are ignored.
      return
  }
}
