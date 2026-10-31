import { randomUUID } from 'node:crypto'
import {
  ANALYTICS_EVENT_TYPE,
  CAMPAIGN_TOPIC,
  CATALOG_TOPIC,
  externalId,
  FIRST_PARTY_SELLER,
  IDENTITY_TOPIC,
  type AnalyticsEventPayload,
  type ReferenceEventPayload,
  type ReferencePayloads,
} from '@basketline/contracts'
import { serviceUnavailable, type BusMessage, type EventBus, type Logger } from '@basketline/platform'
import type { IncomingReferenceEvent } from '../validators/reference.validator.ts'

/**
 * Reference data and server-side identity from a retailer's backend (contracts:
 * retail.ts). Each update is published with its state's updatedAt as the version,
 * keyed by the entity, so the newest wins in every consumer. A retailer's own
 * IDs become UUIDs here (externalId), the same in every channel.
 */
export function createReferenceService({ bus, logger }: { bus: EventBus; logger: Logger }) {
  function envelope(eventName: string, aggregateId: string, updatedAt: string, payload: object) {
    return { eventId: randomUUID(), eventType: eventName, eventVersion: 1, occurredAt: updatedAt, producer: 'analytics-service', aggregateId, aggregateVersion: Date.parse(updatedAt), payload }
  }

  function toMessages(tenantId: string, event: IncomingReferenceEvent, now: string): BusMessage[] {
    const updatedAt = event.updatedAt ? new Date(event.updatedAt).toISOString() : now
    const d = event.data as Record<string, any>
    const seller = (value: string | null | undefined) => externalId(tenantId, 'seller', value ?? FIRST_PARTY_SELLER)
    const reference = <N extends keyof ReferencePayloads>(topic: string, name: N, entityId: string, state: Omit<ReferenceEventPayload<N>, 'tenantId' | 'updatedAt'>): BusMessage =>
      ({ topic, key: entityId, envelope: envelope(name, entityId, updatedAt, { ...state, tenantId, updatedAt }) })
    switch (event.eventName) {
      case 'seller_upserted': {
        const sellerId = seller(d.sellerId)
        return [reference(CATALOG_TOPIC, 'seller_upserted', sellerId, { sellerId, name: d.name })]
      }
      case 'product_upserted': {
        const productId = externalId(tenantId, 'product', d.productId)
        const sellerId = seller(d.sellerId)
        const product = reference(CATALOG_TOPIC, 'product_upserted', productId, {
          productId, sellerId, name: d.name, category: d.category ?? null, price: d.price ?? null, isActive: d.isActive ?? true,
        })
        // A product sent without a seller is the retailer's own: its first-party seller exists too.
        return d.sellerId == null ? [reference(CATALOG_TOPIC, 'seller_upserted', sellerId, { sellerId, name: 'First party' }), product] : [product]
      }
      case 'product_removed': {
        const productId = externalId(tenantId, 'product', d.productId)
        return [reference(CATALOG_TOPIC, 'product_removed', productId, { productId })]
      }
      case 'campaign_upserted': {
        const campaignId = externalId(tenantId, 'campaign', d.campaignId)
        return [reference(CAMPAIGN_TOPIC, 'campaign_upserted', campaignId, {
          campaignId,
          sellerId: seller(d.sellerId),
          title: d.title,
          status: d.status,
          startTime: d.startTime ?? null,
          endTime: d.endTime ?? null,
          archived: d.archived ?? false,
          productIds: (d.productIds as string[]).map((id) => externalId(tenantId, 'product', id)),
        })]
      }
      case 'campaign_removed': {
        const campaignId = externalId(tenantId, 'campaign', d.campaignId)
        return [reference(CAMPAIGN_TOPIC, 'campaign_removed', campaignId, { campaignId })]
      }
      default: {
        // Server-side identity: stored like the shopper's own identity events (Flink),
        // and user_deleted is applied by analytics-service (events/identity.consumer.ts).
        const userId = (d.userId as string).toLowerCase()
        const payload: AnalyticsEventPayload = {
          eventId: randomUUID(),
          eventType: 'identity',
          eventName: event.eventName as AnalyticsEventPayload['eventName'],
          campaignId: null,
          productId: null,
          sellerId: null,
          userId,
          userType: 'registered',
          clientType: 'web',
          tenantId,
          pageName: null,
          featureName: null,
          properties: d.visitorId ? { visitorId: (d.visitorId as string).toLowerCase() } : {},
          timestamp: updatedAt,
          receivedAt: now,
        }
        return [{ topic: IDENTITY_TOPIC, key: userId, envelope: { ...envelope(ANALYTICS_EVENT_TYPE, payload.eventId, updatedAt, payload), eventType: ANALYTICS_EVENT_TYPE, aggregateVersion: 1 } }]
      }
    }
  }

  return {
    async publish(tenantId: string, events: IncomingReferenceEvent[]): Promise<number> {
      const now = new Date().toISOString()
      const messages = events.flatMap((event) => toMessages(tenantId, event, now))
      try {
        await bus.publish(messages)
      } catch (error) {
        logger.error({ err: error, tenantId, count: messages.length }, 'failed to publish reference data')
        throw serviceUnavailable('EVENTS_NOT_DELIVERED', 'The updates could not be recorded right now. Try again shortly.')
      }
      return events.length
    },
  }
}

export type ReferenceService = ReturnType<typeof createReferenceService>
