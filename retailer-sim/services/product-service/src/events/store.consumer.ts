import { createHash } from 'node:crypto'
import type { EventEnvelope } from '@basketline/contracts'
import { writeAudit, type PublishEvents } from '@basketline/platform'
import type { BasketlineSender, RetailerEvent, RetailerEventPayloads } from '@retailer-sim/shared'
import type { Db } from '../db/client.ts'
import { insertProductIfAbsent, insertSellerIfAbsent, type Product, type Seller } from '../repositories/product.repository.ts'
import { saveStore } from '../repositories/store.repository.ts'
import { SAMPLE_CATALOG } from '../seed/sampleCatalog.ts'
import { basketlineProduct, stateEvent } from '../services/product.service.ts'

/** The catalog in an order fixed by the tenant, so applying the event again picks the same products. */
function samplesFor(tenantId: string) {
  const rank = (index: number) => createHash('sha256').update(`${tenantId}:${index}`).digest('hex')
  return SAMPLE_CATALOG.map((sample, index) => ({ sample, key: rank(index) }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ sample }) => sample)
}

/**
 * A store connected to Basketline (StoreConnected, from retailer-auth-service):
 * keeps its sealed API key, seeds its catalog with the planned sellers and
 * products, created by its staff user, and sends them to Basketline. Rows are
 * inserted by their planned IDs, so a redelivered event creates nothing twice;
 * ProductCreated goes out for new ones only.
 */
export function createStoreConnector({ db, publish, basketline }: { db: Db; publish: PublishEvents; basketline?: BasketlineSender }) {
  return async (envelope: EventEnvelope): Promise<void> => {
    if (envelope.eventType !== 'StoreConnected') return
    const { tenantId, sealedApiKey, connectedBy, seed } = envelope.payload as RetailerEventPayloads['StoreConnected']
    const samples = samplesFor(tenantId)
    const sellerOf = new Map(seed.sellers.flatMap((seller) => seller.productIds.map((productId) => [productId, seller.sellerId] as const)))
    const { events, sellers, products } = await db.transaction(async (tx) => {
      await saveStore(tx, tenantId, sealedApiKey)
      const events: RetailerEvent[] = []
      const sellers: Seller[] = []
      const products: Product[] = []
      for (const seller of seed.sellers) {
        const inserted = await insertSellerIfAbsent(tx, { id: seller.sellerId, tenantId, name: seller.name })
        if (inserted) sellers.push(inserted)
      }
      for (const [index, id] of seed.productIds.entries()) {
        const sample = samples[index % samples.length]!
        const product = await insertProductIfAbsent(tx, { id, tenantId, sellerId: sellerOf.get(id)!, ...sample, createdBy: connectedBy, updatedBy: connectedBy })
        if (!product) continue
        await writeAudit(tx, { actorId: connectedBy, action: 'product.created', subjectType: 'product', subjectId: id, details: { seededFrom: envelope.eventId } })
        events.push(stateEvent(product, 'ProductCreated'))
        products.push(product)
      }
      return { events, sellers, products }
    })
    await publish(events)
    // As the store's backend: its sellers first, so its products' sellers are known.
    await basketline?.send(tenantId, async (server) => {
      if (sellers.length > 0) await server.catalog.upsertSeller(sellers.map(({ id: sellerId, name, createdAt: updatedAt }) => ({ sellerId, name, updatedAt })))
      if (products.length > 0) await server.catalog.upsertProduct(products.map(basketlineProduct))
    })
  }
}
