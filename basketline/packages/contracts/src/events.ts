/**
 * Basketline's own Kafka events (users, sessions, tenants).
 *
 * Every message value is an EventEnvelope. The message key is aggregateId, so
 * all events for one user or tenant land on the same partition and are
 * consumed in order. Consumers still compare aggregateVersion before applying
 * an event, which makes replays and re-deliveries harmless.
 */
import type { Role } from './roles.ts'

export const TOPICS = {
  users: 'auth.user.v1',
  sessions: 'auth.session.v1',
  tenants: 'auth.tenant.v1',
} as const

// The envelope every message carries is defined with the event bus.
export type { EventEnvelope } from '@divya2424/basketline-kafka'

/** A newly onboarded tenant: its tier sizes its ingestion budget. */
export interface TenantOnboardedPayload {
  tenantId: string
  name: string
  tier: string
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
}

