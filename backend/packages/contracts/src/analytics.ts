/**
 * Analytics events: what shoppers do. Every event has a type and a name:
 *   interaction  ad and storefront activity (INTERACTIONS_TOPIC)
 *   identity     login and user activity (IDENTITY_TOPIC): what the shopper's
 *                client sends, and what only the retailer's server can vouch for
 * analytics-service publishes them; the Flink job (backend/flink) reads both topics
 * and writes the SERVING_TOPICS, which ClickHouse loads (infra/clickhouse/03_kafka.sql).
 * What exists (sellers, products, campaigns) is reference data: retail.ts.
 */

/** The app an event was sent from; every metric is counted per client type and in total. */
export const CLIENT_TYPES = ['web', 'mobile'] as const
export type ClientType = (typeof CLIENT_TYPES)[number]

/** Who sent an event: a registered user (access token) or a visitor (visitor token). */
export const USER_TYPES = ['visitor', 'registered'] as const
export type UserType = (typeof USER_TYPES)[number]

/**
 * The events the campaign metrics count. They always carry a campaignId. A click
 * with a productId can be credited with a later add_to_cart of that product by
 * the same user (the Flink job does the attribution; clients send no link).
 */
export const METRIC_EVENT_NAMES = ['impression', 'click'] as const
/** Other storefront activity, stored for later analysis; campaignId is optional. */
export const ACTIVITY_EVENT_NAMES = [
  'home_view',
  'campaign_navigation',
  'product_impression',
  'product_click',
  'add_to_cart',
  'cart_view',
  'cart_quantity_update',
  'remove_from_cart',
] as const
export const INTERACTION_EVENT_NAMES = [...METRIC_EVENT_NAMES, ...ACTIVITY_EVENT_NAMES] as const
/** Login and user activity the shopper's own client sends (the SDK's identity(), identify() and reset()). */
export const CLIENT_IDENTITY_EVENT_NAMES = ['login_click', 'signup_click', 'login', 'logout'] as const
/**
 * What only the retailer's server can vouch for (POST /api/v1/retail/identity, with its
 * API key): a login succeeded (the visitor became this customer), and erasure.
 */
export const SERVER_IDENTITY_EVENT_NAMES = ['user_identified', 'user_deleted'] as const
/** What a shopper's client may send (POST /api/v1/analytics/events). */
export const ANALYTICS_EVENT_NAMES = [...INTERACTION_EVENT_NAMES, ...CLIENT_IDENTITY_EVENT_NAMES] as const
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number] | (typeof SERVER_IDENTITY_EVENT_NAMES)[number]

/** An analytics event's type (the payload's eventType). */
export const ANALYTICS_EVENT_KINDS = ['interaction', 'identity'] as const
export type AnalyticsEventKind = (typeof ANALYTICS_EVENT_KINDS)[number]

/** An event's type, from its name. */
export function eventTypeOf(eventName: AnalyticsEventName): AnalyticsEventKind {
  return (INTERACTION_EVENT_NAMES as readonly string[]).includes(eventName) ? 'interaction' : 'identity'
}

export const ANALYTICS_EVENT_TYPE = 'AnalyticsEventRecorded'

/**
 * Written by the Flink job: every valid event as an analytics.events row, each
 * (add_to_cart, earlier click on that product by the same user) pair as an
 * analytics.attributed_baskets row, and each user session as an analytics.sessions row.
 * The job reads only INTERACTIONS_TOPIC, IDENTITY_TOPIC and WATERMARK_HEARTBEAT_TOPIC, never its own output.
 */
export const SERVING_TOPICS = {
  events: 'serving.events.v1',
  attributedBaskets: 'serving.attributed_baskets.v1',
  sessions: 'serving.sessions.v1',
} as const

/**
 * Every interaction, whatever its name: one shared topic, since all of them have
 * the same retention, access and processing (the event name is in the payload).
 * A topic of its own is only for a domain that differs in one of those.
 */
export const INTERACTIONS_TOPIC = 'retail.interactions.v1'

/**
 * Identity events: their own topic, since part of them comes only from the
 * retailer's server (different access), and analytics-service applies erasure
 * (user_deleted) from it (different processing).
 */
export const IDENTITY_TOPIC = 'retail.identity-events.v1'

/** The topic for an event, by its type. */
export function topicOf(eventName: AnalyticsEventName): string {
  return eventTypeOf(eventName) === 'interaction' ? INTERACTIONS_TOPIC : IDENTITY_TOPIC
}

/**
 * analytics-service publishes the current time here every 30 s. The Flink job
 * reads it with the interactions, so the session windows' watermark keeps moving
 * when no events arrive (after a replay, or a quiet night); without it, sessions
 * would stay open until the next event. It has no eventId or tenantId, so the
 * job's events view drops it before anything is written. A topic of its own:
 * it keeps 1 hour, not 14 days.
 */
export const WATERMARK_HEARTBEAT_TOPIC = 'retail.heartbeat.v1'

/** Envelope payload of an AnalyticsEventRecorded message. Missing values are null. */
export interface AnalyticsEventPayload {
  eventId: string
  eventType: AnalyticsEventKind
  eventName: AnalyticsEventName
  campaignId: string | null
  productId: string | null
  /**
   * The seller of productId, from the catalog (retail.ts), stamped on arrival.
   * Null without a product, or for a product the catalog hasn't sent yet.
   */
  sellerId: string | null
  /**
   * The person, from the sender's token (never from the request body): the
   * registered user's ID, or the visitor's UUID, which the client keeps when the
   * visitor registers. Every event has one.
   */
  userId: string
  userType: UserType
  /** From the sender's token: the app it signed in with, or asked a visitor token for. */
  clientType: ClientType
  /** The tenant (UUID), from the sender's access or visitor token. */
  tenantId: string
  pageName: string | null
  featureName: string | null
  properties: Record<string, unknown>
  /** When it happened (client clock), ISO 8601. */
  timestamp: string
  /** When analytics-service received it, ISO 8601. */
  receivedAt: string
}
