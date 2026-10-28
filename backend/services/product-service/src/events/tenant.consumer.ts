import { createHash } from 'node:crypto'
import type { EventEnvelope, EventPayloads } from '@ecommerce-analytics/contracts'
import { writeAudit, type NewEvent, type PublishEvents } from '@ecommerce-analytics/platform'
import type { Db } from '../db/client.ts'
import { insertProductIfAbsent } from '../repositories/product.repository.ts'
import { SAMPLE_CATALOG } from '../seed/sampleCatalog.ts'
import { stateEvent } from '../services/product.service.ts'

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
export function createTenantSeeder({ db, publish }: { db: Db; publish: PublishEvents }) {
  return async (envelope: EventEnvelope): Promise<void> => {
    if (envelope.eventType !== 'TenantOnboarded') return
    const { tenantId, onboardedBy, seed } = envelope.payload as EventPayloads['TenantOnboarded']
    const samples = samplesFor(tenantId)
    const events = await db.transaction(async (tx) => {
      const created: NewEvent[] = []
      for (const [index, id] of seed.productIds.entries()) {
        const sample = samples[index % samples.length]!
        const product = await insertProductIfAbsent(tx, { id, tenantId, ...sample, createdBy: onboardedBy, updatedBy: onboardedBy })
        if (!product) continue
        await writeAudit(tx, { actorId: onboardedBy, action: 'product.created', subjectType: 'product', subjectId: id, details: { seededFrom: envelope.eventId } })
        created.push(stateEvent(product, 'ProductCreated'))
      }
      return created
    })
    await publish(events)
  }
}
