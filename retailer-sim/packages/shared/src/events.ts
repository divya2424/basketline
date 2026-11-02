/**
 * The simulated retailer's own Kafka events: its stores, products and campaigns.
 * Locally it shares Basketline's Kafka cluster (its own topics), never its
 * events: it talks to Basketline only through Basketline's public API.
 */
import type { EventRegistry } from '@basketline/platform'
import type { SeedPlan } from './seed.ts'

export const RETAILER_TOPICS = {
  stores: 'retailer.store.v1',
  products: 'product.v1',
  campaigns: 'campaign.v1',
} as const

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed'

export interface ProductState {
  productId: string
  /** The tenant (UUID) that owns the product; it never changes. */
  tenantId: string
  /** The seller (UUID) who publishes it; it never changes. */
  sellerId: string
  name: string
  price: number
  image: string | null
  category: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
  /** The users (UUIDs) who created and last changed the product. */
  createdBy: string
  updatedBy: string
}

export interface CampaignState {
  campaignId: string
  /** The tenant (UUID) that owns the campaign; it never changes. */
  tenantId: string
  /** The seller (UUID) who runs it; its products are this seller's. Null: a campaign from before sellers. */
  sellerId: string | null
  title: string
  type: string
  status: CampaignStatus
  startTime: string | null
  endTime: string | null
  archived: boolean
  updatedAt: string
}

/**
 * A store connected to Basketline (retailer-auth-service): its Basketline tenant,
 * the API key product- and campaign-service send its records with, and the demo
 * catalog to seed it with. The IDs are drawn once (seed.ts), so applying the event
 * again creates nothing twice.
 */
export interface StoreConnectedPayload {
  tenantId: string
  name: string
  /** Basketline's API key for the store, sealed (secrets.ts): never in clear on Kafka. */
  sealedApiKey: string
  /** The store's staff user, recorded as the seeded rows' creator. */
  connectedBy: string
  seed: SeedPlan
}

export interface RetailerEventPayloads {
  StoreConnected: StoreConnectedPayload
  ProductCreated: ProductState
  ProductUpdated: ProductState
  ProductDeactivated: { productId: string; tenantId: string; deactivatedAt: string; deactivatedBy: string }
  CampaignCreated: CampaignState
  CampaignUpdated: CampaignState
  CampaignProductAssociated: { campaignId: string; productId: string; position: number | null }
  CampaignProductRemoved: { campaignId: string; productId: string }
}

export type RetailerEventType = keyof RetailerEventPayloads

/** Topic and current schema version of each event type, for createEventPublisher's registry. */
export const RETAILER_EVENTS: Record<RetailerEventType, { topic: string; version: number }> & EventRegistry = {
  StoreConnected: { topic: RETAILER_TOPICS.stores, version: 1 },
  ProductCreated: { topic: RETAILER_TOPICS.products, version: 1 },
  ProductUpdated: { topic: RETAILER_TOPICS.products, version: 1 },
  ProductDeactivated: { topic: RETAILER_TOPICS.products, version: 1 },
  CampaignCreated: { topic: RETAILER_TOPICS.campaigns, version: 1 },
  CampaignUpdated: { topic: RETAILER_TOPICS.campaigns, version: 1 },
  CampaignProductAssociated: { topic: RETAILER_TOPICS.campaigns, version: 1 },
  CampaignProductRemoved: { topic: RETAILER_TOPICS.campaigns, version: 1 },
}

export interface RetailerEvent<T extends RetailerEventType = RetailerEventType> {
  eventType: T
  aggregateId: string
  aggregateVersion: number
  payload: RetailerEventPayloads[T]
}

/** Builds a typed RetailerEvent. */
export function retailerEvent<T extends RetailerEventType>(eventType: T, aggregateId: string, aggregateVersion: number, payload: RetailerEventPayloads[T]): RetailerEvent<T> {
  return { eventType, aggregateId, aggregateVersion, payload }
}
