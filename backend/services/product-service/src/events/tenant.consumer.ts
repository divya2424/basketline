import { createHash } from 'node:crypto'
import type { EventEnvelope, EventPayloads } from '@basketline/contracts'
import { writeAudit, type NewEvent, type PublishEvents, type ReferenceUpdate, type RetailerIntegration } from '@basketline/platform'
import type { Db } from '../db/client.ts'
import { deleteTenantProducts, insertProductIfAbsent, insertSellerIfAbsent } from '../repositories/product.repository.ts'
import { SAMPLE_CATALOG } from '../seed/sampleCatalog.ts'
import { productUpdate, stateEvent } from '../services/product.service.ts'

/** The catalog in an order fixed by the tenant, so applying the event again picks the same products. */
function samplesFor(tenantId: string) {
  const rank = (index: number) => createHash('sha256').update(`${tenantId}:${index}`).digest('hex')
  return SAMPLE_CATALOG.map((sample, index) => ({ sample, key: rank(index) }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ sample }) => sample)
}

/**
 * Seeds an onboarded tenant with the products auth-service planned (TenantOnboarded),
 * created by its onboarding user. Products are inserted by their planned IDs, so a
 * redelivered event creates nothing twice; ProductCreated goes out for new ones only.
 */
export function createTenantSeeder({ db, publish, retailer }: { db: Db; publish: PublishEvents; retailer?: RetailerIntegration }) {
  return async (envelope: EventEnvelope): Promise<void> => {
    if (envelope.eventType !== 'TenantOnboarded') return
    const { tenantId, onboardedBy, seed } = envelope.payload as EventPayloads['TenantOnboarded']
    const samples = samplesFor(tenantId)
    const sellerOf = new Map(seed.sellers.flatMap((seller) => seller.productIds.map((productId) => [productId, seller.sellerId] as const)))
    const { events, updates } = await db.transaction(async (tx) => {
      const created: NewEvent[] = []
      const updates: ReferenceUpdate[] = []
      for (const seller of seed.sellers) {
        const inserted = await insertSellerIfAbsent(tx, { id: seller.sellerId, tenantId, name: seller.name })
        if (inserted) updates.push({ eventName: 'seller_upserted', updatedAt: inserted.createdAt.toISOString(), data: { sellerId: inserted.id, name: inserted.name } })
      }
      for (const [index, id] of seed.productIds.entries()) {
        const sample = samples[index % samples.length]!
        const product = await insertProductIfAbsent(tx, { id, tenantId, sellerId: sellerOf.get(id)!, ...sample, createdBy: onboardedBy, updatedBy: onboardedBy })
        if (!product) continue
        await writeAudit(tx, { actorId: onboardedBy, action: 'product.created', subjectType: 'product', subjectId: id, details: { seededFrom: envelope.eventId } })
        created.push(stateEvent(product, 'ProductCreated'))
        updates.push(productUpdate(product))
      }
      return { events: created, updates }
    })
    await publish(events)
    await retailer?.send(tenantId, 'catalog', updates)
  }
}

/**
 * A deleted tenant (TenantDeleted): its products go. No product events are
 * published: campaign-service deletes its own copy from the same event.
 */
export async function handleTenantDeleted(db: Db, envelope: EventEnvelope): Promise<void> {
  if (envelope.eventType !== 'TenantDeleted') return
  const { tenantId } = envelope.payload as EventPayloads['TenantDeleted']
  await deleteTenantProducts(db, tenantId)
}
