/**
 * Analytics events. analytics-service publishes each accepted event to the
 * topic for its event name; the Flink job (backend/flink) reads all of them
 * (pattern `analytics\..+\.v1`) and writes the SERVING_TOPICS, which ClickHouse
 * loads (infra/clickhouse/03_kafka.sql).
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
  'login_click',
] as const
export const ANALYTICS_EVENT_NAMES = [...METRIC_EVENT_NAMES, ...ACTIVITY_EVENT_NAMES] as const
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]

export const ANALYTICS_EVENT_TYPE = 'AnalyticsEventRecorded'

/**
 * Written by the Flink job: every valid event as an analytics.events row, each
 * (add_to_cart, earlier click on that product by the same user) pair as an
 * analytics.attributed_baskets row, and each user session as an analytics.sessions row.
 * Their names don't match `analytics\..+\.v1`, so the job never reads its own output.
 */
export const SERVING_TOPICS = {
  events: 'serving.events.v1',
  attributedBaskets: 'serving.attributed_baskets.v1',
  sessions: 'serving.sessions.v1',
} as const

/**
 * analytics-service publishes the current time here every 30 s. It matches the
 * Flink job's topic pattern, so the session windows' watermark keeps moving when
 * no events arrive (after a replay, or a quiet night); without it, sessions would
 * stay open until the next event. It has no eventId or tenantId, so the job's
 * events view drops it before anything is written.
 */
export const WATERMARK_HEARTBEAT_TOPIC = 'analytics.heartbeat.v1'

/** e.g. analytics.add_to_cart.v1 */
export function analyticsTopic(eventName: AnalyticsEventName): string {
  return `analytics.${eventName}.v1`
}

/** Envelope payload of an AnalyticsEventRecorded message. Missing values are null. */
export interface AnalyticsEventPayload {
  eventId: string
  eventName: AnalyticsEventName
  campaignId: string | null
  productId: string | null
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
