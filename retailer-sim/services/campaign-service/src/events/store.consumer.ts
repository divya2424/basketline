import { randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@basketline/contracts'
import { writeAudit, type PublishEvents } from '@basketline/platform'
import { retailerEvent, type BasketlineSender, type RetailerEvent, type RetailerEventPayloads } from '@retailer-sim/shared'
import type { Db } from '../db/client.ts'
import { findCampaign, insertAssociation, insertCampaignIfAbsent } from '../repositories/campaign.repository.ts'
import { insertPlacementsIfAbsent } from '../repositories/placement.repository.ts'
import { saveStore } from '../repositories/store.repository.ts'
import { basketlineCampaign, basketlineCampaignProducts, stateEvent } from '../services/campaign.service.ts'
import { DEFAULT_PLACEMENTS } from '../services/placement.service.ts'

const TITLES = ['Launch Deals', 'Weekend Picks']

/**
 * A store connected to Basketline (StoreConnected, from retailer-auth-service):
 * keeps its sealed API key, adds the default placements, seeds the planned
 * active campaigns (one placement after the other), each with its
 * planned products, created by its staff user, and sends them to Basketline.
 * Campaigns are inserted by their planned IDs, so a redelivered event creates
 * nothing twice. The products aren't checked against the local copy:
 * product-service creates them from the same plan, and their details arrive
 * over product.v1 shortly after (the campaign products whose details are known
 * go to Basketline now, the others then).
 */
export function createStoreConnector({ db, publish, basketline }: { db: Db; publish: PublishEvents; basketline?: BasketlineSender }) {
  return async (envelope: EventEnvelope): Promise<void> => {
    if (envelope.eventType !== 'StoreConnected') return
    const { tenantId, name, sealedApiKey, connectedBy, seed } = envelope.payload as RetailerEventPayloads['StoreConnected']
    const { events, seeded } = await db.transaction(async (tx) => {
      await saveStore(tx, tenantId, sealedApiKey)
      await insertPlacementsIfAbsent(tx, tenantId, DEFAULT_PLACEMENTS)
      const events: RetailerEvent[] = []
      const seeded: string[] = []
      for (const [index, planned] of seed.campaigns.entries()) {
        const campaign = await insertCampaignIfAbsent(tx, {
          id: planned.campaignId,
          tenantId,
          sellerId: planned.sellerId,
          title: `${name} ${TITLES[index % TITLES.length]}`,
          placement: DEFAULT_PLACEMENTS[index % DEFAULT_PLACEMENTS.length]!.key,
          description: `Hand-picked products from ${name}.`,
          status: 'active',
          startTime: null,
          endTime: null,
          createdBy: connectedBy,
          updatedBy: connectedBy,
        })
        if (!campaign) continue
        events.push(stateEvent(campaign, 'CampaignCreated'))
        for (const [position, productId] of planned.productIds.entries()) {
          await insertAssociation(tx, { id: randomUUID(), tenantId, campaignId: campaign.id, productId, position: position + 1, createdBy: connectedBy })
          events.push(retailerEvent('CampaignProductAssociated', campaign.id, campaign.version, { campaignId: campaign.id, productId, position: position + 1 }))
        }
        await writeAudit(tx, { actorId: connectedBy, action: 'campaign.created', subjectType: 'campaign', subjectId: campaign.id, details: { productIds: planned.productIds, seededFrom: envelope.eventId } })
        seeded.push(campaign.id)
      }
      return { events, seeded }
    })
    await publish(events)
    // As the store's backend: the seeded campaigns, with their products, to Basketline.
    const found = await Promise.all(seeded.map(async (id) => (await findCampaign(db, tenantId, id))!))
    const campaigns = found.map(basketlineCampaign).filter((campaign) => campaign !== null)
    const products = (await Promise.all(found.map((campaign) => basketlineCampaignProducts(db, tenantId, campaign.id, campaign.productIds)))).flat()
    if (campaigns.length > 0) await basketline?.send(tenantId, async (server) => {
      await server.campaigns.upsert(campaigns)
      if (products.length > 0) await server.campaigns.addProducts(products)
    })
  }
}
