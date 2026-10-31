import { randomUUID } from 'node:crypto'
import type { EventEnvelope, EventPayloads } from '@basketline/contracts'
import { event, writeAudit, type NewEvent, type PublishEvents, type ReferenceUpdate, type RetailerIntegration } from '@basketline/platform'
import type { Db } from '../db/client.ts'
import { deleteTenantCampaigns, findCampaign, insertAssociation, insertCampaignIfAbsent } from '../repositories/campaign.repository.ts'
import { campaignUpdate, stateEvent } from '../services/campaign.service.ts'

const TITLES = ['Launch Deals', 'Weekend Picks']

/**
 * Seeds an onboarded tenant with the active campaigns auth-service planned
 * (TenantOnboarded), each with its planned products, created by the onboarding
 * user. Campaigns are inserted by their planned IDs, so a redelivered event
 * creates nothing twice. The products aren't checked against the local copy:
 * product-service creates them from the same plan, and their details arrive
 * over product.v1 shortly after.
 */
export function createTenantSeeder({ db, publish, retailer }: { db: Db; publish: PublishEvents; retailer?: RetailerIntegration }) {
  return async (envelope: EventEnvelope): Promise<void> => {
    if (envelope.eventType !== 'TenantOnboarded') return
    const { tenantId, name, onboardedBy, seed } = envelope.payload as EventPayloads['TenantOnboarded']
    const { events, seeded } = await db.transaction(async (tx) => {
      const created: NewEvent[] = []
      const seeded: string[] = []
      for (const [index, planned] of seed.campaigns.entries()) {
        const campaign = await insertCampaignIfAbsent(tx, {
          id: planned.campaignId,
          tenantId,
          sellerId: planned.sellerId,
          title: `${name} ${TITLES[index % TITLES.length]}`,
          // The storefront carousel shows only product_collection campaigns.
          type: 'product_collection',
          description: `Hand-picked products from ${name}.`,
          status: 'active',
          startTime: null,
          endTime: null,
          createdBy: onboardedBy,
          updatedBy: onboardedBy,
        })
        if (!campaign) continue
        created.push(stateEvent(campaign, 'CampaignCreated'))
        for (const [position, productId] of planned.productIds.entries()) {
          await insertAssociation(tx, { id: randomUUID(), tenantId, campaignId: campaign.id, productId, position: position + 1, createdBy: onboardedBy })
          created.push(event('CampaignProductAssociated', campaign.id, campaign.version, { campaignId: campaign.id, productId, position: position + 1 }))
        }
        await writeAudit(tx, { actorId: onboardedBy, action: 'campaign.created', subjectType: 'campaign', subjectId: campaign.id, details: { productIds: planned.productIds, seededFrom: envelope.eventId } })
        seeded.push(campaign.id)
      }
      return { events: created, seeded }
    })
    await publish(events)
    // As the retailer's backend: the seeded campaigns, with their products, to Basketline.
    const updates: ReferenceUpdate[] = []
    for (const id of seeded) {
      const update = campaignUpdate((await findCampaign(db, tenantId, id))!)
      if (update) updates.push(update)
    }
    await retailer?.send(tenantId, 'campaigns', updates)
  }
}

/** A deleted tenant (TenantDeleted): its campaigns, their products and the local product copy go, in one transaction. */
export async function handleTenantDeleted(db: Db, envelope: EventEnvelope): Promise<void> {
  if (envelope.eventType !== 'TenantDeleted') return
  const { tenantId } = envelope.payload as EventPayloads['TenantDeleted']
  await db.transaction((tx) => deleteTenantCampaigns(tx, tenantId))
}
