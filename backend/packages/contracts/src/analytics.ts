/**
 * Analytics events. analytics-service publishes each accepted event to the
 * topic for its event name; the Spark streaming job (backend/streaming) reads
 * all of them (pattern `analytics\..+\.v1`) and writes them to ClickHouse.
 */

/** The three events the campaign metrics count. They always carry a campaignId. */
export const METRIC_EVENT_NAMES = ['impression', 'click', 'click_to_basket'] as const
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
  /** From the access token (null for a visitor), never from the request body. */
  userId: string | null
  /** The tenant (UUID), from the sender's access or visitor token. */
  tenantId: string
  pageName: string | null
  featureName: string | null
  /** For click_to_basket: the eventId of the click it is credited to. */
  attributionId: string | null
  properties: Record<string, unknown>
  /** When it happened (client clock), ISO 8601. */
  timestamp: string
  /** When analytics-service received it, ISO 8601. */
  receivedAt: string
}
