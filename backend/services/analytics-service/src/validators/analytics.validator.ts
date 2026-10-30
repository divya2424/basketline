import { isIsoDate, isNonEmptyString, isOneOf, isPlainObject, isUuid, unknownKeys } from '@basketline/platform'
import { ANALYTICS_EVENT_NAMES as EVENT_NAMES, METRIC_EVENT_NAMES, USER_TYPES, type AnalyticsEventName, type UserType } from '@basketline/contracts'

export const MAX_EVENTS_PER_REQUEST = 100

/**
 * An event as clients send it. What it's about (campaignId, productId, and any
 * attribute added later) goes in properties; ingestion lifts the two IDs out,
 * since attribution and the /ad metrics key on them.
 */
export interface IncomingEvent {
  eventId: string
  eventName: AnalyticsEventName
  pageName?: string | null
  featureName?: string | null
  timestamp: string
  properties?: { campaignId?: string | null; productId?: string | null; [key: string]: unknown }
}

const EVENT_FIELDS = ['eventId', 'eventName', 'pageName', 'featureName', 'timestamp', 'properties']

function validateEvent(event: unknown, at: string): string[] {
  if (!isPlainObject(event)) return [`${at} must be an object`]
  // userId is not accepted from clients: it comes from the access token.
  const errors = unknownKeys(event, EVENT_FIELDS).map((key) => `${at}: unknown field "${key}"`)
  if (!isUuid(event.eventId)) errors.push(`${at}.eventId must be a UUID`)
  if (!isOneOf(event.eventName, EVENT_NAMES)) errors.push(`${at}.eventName must be one of ${EVENT_NAMES.join(', ')}`)
  if (!isIsoDate(event.timestamp)) errors.push(`${at}.timestamp must be an ISO 8601 date-time`)
  for (const field of ['pageName', 'featureName'] as const) {
    if (event[field] != null && !isNonEmptyString(event[field], 100)) errors.push(`${at}.${field} must be a string (max 100 characters)`)
  }
  if (event.properties !== undefined && !isPlainObject(event.properties)) return [...errors, `${at}.properties must be an object`]
  const { campaignId, productId } = (event.properties ?? {}) as Record<string, unknown>
  // The campaign metrics need a campaign; other activity may or may not have one.
  const campaignRequired = isOneOf(event.eventName, METRIC_EVENT_NAMES)
  if ((campaignRequired || campaignId != null) && !isUuid(campaignId)) errors.push(`${at}.properties.campaignId must be a UUID`)
  if (productId != null && !isUuid(productId)) errors.push(`${at}.properties.productId must be a UUID`)
  return errors
}

/** Who the client says sent the batch; it must match the token (ingestion.controller.ts). */
export interface IngestIdentity {
  tenantId: string
  /** The person: the registered user's ID, or the client's UUID for a visitor. */
  userId: string
  userType: UserType
}

const BODY_FIELDS = ['tenantId', 'userId', 'userType', 'events']

export function validateIngest(body: unknown): string[] {
  if (!isPlainObject(body) || !Array.isArray(body.events)) return ['body must be { "tenantId", "userId", "userType", "events": [...] }']
  const errors = unknownKeys(body, BODY_FIELDS).map((key) => `unknown field "${key}"`)
  if (!isUuid(body.tenantId)) errors.push('tenantId must be a UUID')
  if (!isUuid(body.userId)) errors.push('userId must be a UUID')
  if (!isOneOf(body.userType, USER_TYPES)) errors.push(`userType must be one of ${USER_TYPES.join(', ')}`)
  if (body.events.length === 0 || body.events.length > MAX_EVENTS_PER_REQUEST) {
    return [...errors, `events must contain 1–${MAX_EVENTS_PER_REQUEST} items`]
  }
  return [...errors, ...body.events.flatMap((event, index) => validateEvent(event, `events[${index}]`))]
}

export function validateMetricQuery(query: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (query.from !== undefined && !isIsoDate(query.from)) errors.push('from must be an ISO 8601 date-time')
  if (query.to !== undefined && !isIsoDate(query.to)) errors.push('to must be an ISO 8601 date-time')
  return errors
}
