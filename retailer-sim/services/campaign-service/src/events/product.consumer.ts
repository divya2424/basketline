import type { EventEnvelope } from '@basketline/contracts'
import type { RetailerEventPayloads } from '@retailer-sim/shared'
import type { DbOrTx } from '../db/client.ts'
import { markProductInactive, upsertProductState } from '../repositories/product.repository.ts'

/** Applies product.v1 events to the local products copy. */
export async function handleProductEvent(db: DbOrTx, envelope: EventEnvelope): Promise<void> {
  // Events from before products had tenants: the product's next change counts.
  if (!(envelope.payload as { tenantId?: string }).tenantId) return
  switch (envelope.eventType) {
    case 'ProductCreated':
    case 'ProductUpdated':
      await upsertProductState(db, envelope.payload as RetailerEventPayloads['ProductCreated'], envelope.aggregateVersion)
      return
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
