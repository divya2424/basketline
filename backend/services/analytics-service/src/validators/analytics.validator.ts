import { isIsoDate, isNonEmptyString, isOneOf, isPlainObject, isUuid, unknownKeys } from '@shopsphere/platform'
import { ANALYTICS_EVENT_NAMES as EVENT_NAMES, METRIC_EVENT_NAMES, type AnalyticsEventName } from '@shopsphere/contracts'

export const MAX_EVENTS_PER_REQUEST = 100

export interface IncomingEvent {
  eventId: string
  campaignId?: string | null
  productId?: string | null
  eventName: AnalyticsEventName
  pageName?: string | null
  featureName?: string | null
  timestamp: string
  attributionId?: string | null
  properties?: Record<string, unknown>
}

const EVENT_FIELDS = ['eventId', 'campaignId', 'productId', 'eventName', 'pageName', 'featureName', 'timestamp', 'attributionId', 'properties']

function validateEvent(event: unknown, at: string): string[] {
  if (!isPlainObject(event)) return [`${at} must be an object`]
  // userId is not accepted from clients: it comes from the access token.
  const errors = unknownKeys(event, EVENT_FIELDS).map((key) => `${at}: unknown field "${key}"`)
  if (!isUuid(event.eventId)) errors.push(`${at}.eventId must be a UUID`)
  if (!isOneOf(event.eventName, EVENT_NAMES)) errors.push(`${at}.eventName must be one of ${EVENT_NAMES.join(', ')}`)
  // The campaign metrics need a campaign; other activity may or may not have one.
  const campaignRequired = isOneOf(event.eventName, METRIC_EVENT_NAMES)
  if ((campaignRequired || event.campaignId != null) && !isUuid(event.campaignId)) errors.push(`${at}.campaignId must be a UUID`)
  if (!isIsoDate(event.timestamp)) errors.push(`${at}.timestamp must be an ISO 8601 date-time`)
  if (event.productId != null && !isUuid(event.productId)) errors.push(`${at}.productId must be a UUID`)
  if (event.attributionId != null && !isUuid(event.attributionId)) errors.push(`${at}.attributionId must be a UUID`)
  for (const field of ['pageName', 'featureName'] as const) {
    if (event[field] != null && !isNonEmptyString(event[field], 100)) errors.push(`${at}.${field} must be a string (max 100 characters)`)
  }
  if (event.properties !== undefined && !isPlainObject(event.properties)) errors.push(`${at}.properties must be an object`)
  if (event.eventName === 'click_to_basket') {
    if (event.productId == null) errors.push(`${at}.productId is required for click_to_basket`)
    if (event.attributionId == null) errors.push(`${at}.attributionId (the click's eventId) is required for click_to_basket`)
  } else if (event.attributionId != null) {
    errors.push(`${at}.attributionId is only allowed on click_to_basket events`)
  }
  return errors
}

export function validateIngest(body: unknown): string[] {
  if (!isPlainObject(body) || !Array.isArray(body.events)) return ['body must be { "events": [...] }']
  if (body.events.length === 0 || body.events.length > MAX_EVENTS_PER_REQUEST) {
    return [`events must contain 1–${MAX_EVENTS_PER_REQUEST} items`]
  }
  return body.events.flatMap((event, index) => validateEvent(event, `events[${index}]`))
}

export function validateMetricQuery(query: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (query.from !== undefined && !isIsoDate(query.from)) errors.push('from must be an ISO 8601 date-time')
  if (query.to !== undefined && !isIsoDate(query.to)) errors.push('to must be an ISO 8601 date-time')
  return errors
}
