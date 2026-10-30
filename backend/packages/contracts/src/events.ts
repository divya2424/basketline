/**
 * Kafka event contracts, shared by all services.
 *
 * Every message value is an EventEnvelope. The message key is aggregateId, so
 * all events for one product/campaign/user land on the same partition and are
 * consumed in order. Consumers still compare aggregateVersion before applying
 * an event, which makes replays and re-deliveries harmless.
 */
import type { Role } from './roles.ts'

export const TOPICS = {
  users: 'auth.user.v1',
  sessions: 'auth.session.v1',
  tenants: 'auth.tenant.v1',
  products: 'product.v1',
  campaigns: 'campaign.v1',
} as const

export interface EventEnvelope<P = unknown> {
  eventId: string
  eventType: string
  eventVersion: number
  occurredAt: string
  producer: string
  aggregateId: string
  aggregateVersion: number
  payload: P
}


export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed'

export interface ProductState {
  productId: string
  /** The tenant (UUID) that owns the product; it never changes. */
  tenantId: string
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
  title: string
  type: string
  status: CampaignStatus
  startTime: string | null
  endTime: string | null
  archived: boolean
  updatedAt: string
}

/**
 * A newly onboarded tenant and the demo data to seed it with. The IDs are drawn
 * once by auth-service, so product-service and campaign-service create exactly
 * these rows, and applying the event again changes nothing.
 */
export interface TenantOnboardedPayload {
  tenantId: string
  name: string
  tier: string
  /** The tenant's onboarding user, recorded as the seeded rows' creator. */
  onboardedBy: string
  seed: {
    productIds: string[]
    campaigns: { campaignId: string; productIds: string[] }[]
  }
}

/**
 * A tenant was deleted, with all of its data: each service that holds some of it
 * deletes it when this arrives (keyed by tenant ID, like TenantOnboarded).
 */
export interface TenantDeletedPayload {
  tenantId: string
  name: string
  deletedAt: string
}

/**
 * The websites (origins, e.g. "https://shop.example") whose pages may send the
 * tenant's events through the SDK; empty: any. The whole list each time, with a
 * version that only grows, so the gateway keeps the newest list whatever the order.
 */
export interface TenantOriginsChangedPayload {
  tenantId: string
  origins: string[]
  version: number
  changedAt: string
}

/** Payload of each event type. */
export interface EventPayloads {
  UserCreated: { userId: string; username: string; role: Role; isActive: boolean }
  UserRoleChanged: { userId: string; role: Role; previousRole: Role; changedAt: string }
  UserDisabled: { userId: string; disabledAt: string }
  SessionRevoked: { sessionId: string; userId: string; revokedAt: string; expiresAt: string }
  TenantOnboarded: TenantOnboardedPayload
  TenantDeleted: TenantDeletedPayload
  TenantOriginsChanged: TenantOriginsChangedPayload
  ProductCreated: ProductState
  ProductUpdated: ProductState
  ProductDeactivated: { productId: string; tenantId: string; deactivatedAt: string; deactivatedBy: string }
  CampaignCreated: CampaignState
  CampaignUpdated: CampaignState
  CampaignProductAssociated: { campaignId: string; productId: string; position: number | null }
  CampaignProductRemoved: { campaignId: string; productId: string }
}

export type EventType = keyof EventPayloads

/** Topic and current schema version of each event type. */
export const EVENTS: Record<EventType, { topic: string; version: number }> = {
  UserCreated: { topic: TOPICS.users, version: 1 },
  UserRoleChanged: { topic: TOPICS.users, version: 1 },
  UserDisabled: { topic: TOPICS.users, version: 1 },
  SessionRevoked: { topic: TOPICS.sessions, version: 1 },
  TenantOnboarded: { topic: TOPICS.tenants, version: 1 },
  TenantDeleted: { topic: TOPICS.tenants, version: 1 },
  TenantOriginsChanged: { topic: TOPICS.tenants, version: 1 },
  ProductCreated: { topic: TOPICS.products, version: 1 },
  ProductUpdated: { topic: TOPICS.products, version: 1 },
  ProductDeactivated: { topic: TOPICS.products, version: 1 },
  CampaignCreated: { topic: TOPICS.campaigns, version: 1 },
  CampaignUpdated: { topic: TOPICS.campaigns, version: 1 },
  CampaignProductAssociated: { topic: TOPICS.campaigns, version: 1 },
  CampaignProductRemoved: { topic: TOPICS.campaigns, version: 1 },
}

/** Basic shape check for a message read from Kafka. */
export function isEnvelope(value: unknown): value is EventEnvelope {
  const envelope = value as Partial<EventEnvelope> | null
  return (
    typeof envelope === 'object' &&
    envelope !== null &&
    typeof envelope.eventId === 'string' &&
    typeof envelope.eventType === 'string' &&
    typeof envelope.eventVersion === 'number' &&
    typeof envelope.occurredAt === 'string' &&
    typeof envelope.producer === 'string' &&
    typeof envelope.aggregateId === 'string' &&
    typeof envelope.aggregateVersion === 'number' &&
    typeof envelope.payload === 'object' &&
    envelope.payload !== null
  )
}
