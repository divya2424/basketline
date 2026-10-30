import { randomUUID } from 'node:crypto'
import type { EventEnvelope, EventPayloads } from '@basketline/contracts'
import { event, writeAudit, type NewEvent, type PublishEvents } from '@basketline/platform'
import type { Db } from '../db/client.ts'
import { insertAssociation, insertCampaignIfAbsent } from '../repositories/campaign.repository.ts'
import { stateEvent } from '../services/campaign.service.ts'

const TITLES = ['Launch Deals', 'Weekend Picks']

/**
 * Seeds an onboarded tenant with the active campaigns auth-service planned
 * (TenantOnboarded), each with its planned products, created by the onboarding
 * user. Campaigns are inserted by their planned IDs, so a redelivered event
 * creates nothing twice. The products aren't checked against the local copy:
 * product-service creates them from the same plan, and their details arrive
 * over product.v1 shortly after.
 */
export function createTenantSeeder({ db, publish }: { db: Db; publish: PublishEvents }) {
  return async (envelope: EventEnvelope): Promise<void> => {
    if (envelope.eventType !== 'TenantOnboarded') return
    const { tenantId, name, onboardedBy, seed } = envelope.payload as EventPayloads['TenantOnboarded']
    const events = await db.transaction(async (tx) => {
      const created: NewEvent[] = []
      for (const [index, planned] of seed.campaigns.entries()) {
        const campaign = await insertCampaignIfAbsent(tx, {
          id: planned.campaignId,
          tenantId,
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
      }
      return created
    })
    await publish(events)
  }
}
