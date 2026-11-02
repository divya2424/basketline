import { isIsoDate, isNonEmptyString, isOneOf, isPlainObject, isUuid, unknownKeys } from '@basketline/platform'
import { CAMPAIGN_EVENT_NAMES, CATALOG_EVENT_NAMES, isRetailerId, SERVER_IDENTITY_EVENT_NAMES } from '@basketline/contracts'

export const MAX_REFERENCE_EVENTS_PER_REQUEST = 500
const STATUSES = ['draft', 'active', 'paused', 'completed']

/** One update from the retailer's server: its name, when the state is from (default: now), and the state. */
export interface IncomingReferenceEvent {
  eventName: string
  updatedAt?: string
  data: Record<string, unknown>
}

const id = (data: Record<string, unknown>, field: string, errors: string[], at: string) => {
  if (!isRetailerId(data[field])) errors.push(`${at}.data.${field} must be an ID (a UUID or your own, up to 128 characters)`)
}

/** Field checks per event name; a retailer's own IDs are mapped later (externalId). */
const DATA: Record<string, { fields: string[]; check: (data: Record<string, unknown>, errors: string[], at: string) => void }> = {
  seller_upserted: {
    fields: ['sellerId', 'name'],
    check: (d, e, at) => { id(d, 'sellerId', e, at); if (!isNonEmptyString(d.name, 200)) e.push(`${at}.data.name must be a string (max 200 characters)`) },
  },
  product_upserted: {
    fields: ['productId', 'sellerId', 'name', 'category', 'price', 'isActive'],
    check: (d, e, at) => {
      id(d, 'productId', e, at)
      // Optional: without one, the product is the retailer's own (first-party).
      if (d.sellerId != null) id(d, 'sellerId', e, at)
      if (!isNonEmptyString(d.name, 300)) e.push(`${at}.data.name must be a string (max 300 characters)`)
      if (d.category != null && !isNonEmptyString(d.category, 100)) e.push(`${at}.data.category must be a string (max 100 characters)`)
      if (d.price != null && !(typeof d.price === 'number' && d.price >= 0)) e.push(`${at}.data.price must be a number ≥ 0`)
      if (d.isActive != null && typeof d.isActive !== 'boolean') e.push(`${at}.data.isActive must be true or false`)
    },
  },
  product_removed: { fields: ['productId'], check: (d, e, at) => id(d, 'productId', e, at) },
  campaign_upserted: {
    fields: ['campaignId', 'sellerId', 'title', 'status', 'startTime', 'endTime', 'archived', 'productIds'],
    check: (d, e, at) => {
      id(d, 'campaignId', e, at)
      id(d, 'sellerId', e, at)
      if (!isNonEmptyString(d.title, 200)) e.push(`${at}.data.title must be a string (max 200 characters)`)
      if (!isOneOf(d.status, STATUSES)) e.push(`${at}.data.status must be one of ${STATUSES.join(', ')}`)
      for (const field of ['startTime', 'endTime']) if (d[field] != null && !isIsoDate(d[field])) e.push(`${at}.data.${field} must be an ISO 8601 date-time`)
      if (d.archived != null && typeof d.archived !== 'boolean') e.push(`${at}.data.archived must be true or false`)
      if (!Array.isArray(d.productIds) || d.productIds.length > 500 || !d.productIds.every(isRetailerId)) e.push(`${at}.data.productIds must be a list of up to 500 product IDs`)
    },
  },
  campaign_removed: { fields: ['campaignId'], check: (d, e, at) => id(d, 'campaignId', e, at) },
  // userId: the ID Basketline returned for the shopper (POST /auth/shopper-token).
  user_identified: {
    fields: ['userId', 'visitorId'],
    check: (d, e, at) => {
      if (!isUuid(d.userId)) e.push(`${at}.data.userId must be the shopper's Basketline ID (a UUID)`)
      if (d.visitorId != null && !isUuid(d.visitorId)) e.push(`${at}.data.visitorId must be a UUID`)
    },
  },
  user_deleted: { fields: ['userId'], check: (d, e, at) => { if (!isUuid(d.userId)) e.push(`${at}.data.userId must be the shopper's Basketline ID (a UUID)`) } },
}

/** A validator for one endpoint's event names (catalog, campaigns or identity). */
function referenceValidator(names: readonly string[]) {
  return (body: unknown): string[] => {
    if (!isPlainObject(body) || !Array.isArray(body.events)) return ['body must be { "events": [{ "eventName", "updatedAt", "data" }] }']
    if (body.events.length === 0 || body.events.length > MAX_REFERENCE_EVENTS_PER_REQUEST) return [`events must contain 1–${MAX_REFERENCE_EVENTS_PER_REQUEST} items`]
    return body.events.flatMap((event: unknown, index: number) => {
      const at = `events[${index}]`
      if (!isPlainObject(event)) return [`${at} must be an object`]
      const errors = unknownKeys(event, ['eventName', 'updatedAt', 'data']).map((key) => `${at}: unknown field "${key}"`)
      if (!isOneOf(event.eventName, names)) return [...errors, `${at}.eventName must be one of ${names.join(', ')}`]
      if (event.updatedAt != null && !isIsoDate(event.updatedAt)) errors.push(`${at}.updatedAt must be an ISO 8601 date-time`)
      if (!isPlainObject(event.data)) return [...errors, `${at}.data must be an object`]
      const spec = DATA[event.eventName as string]!
      errors.push(...unknownKeys(event.data, spec.fields).map((key) => `${at}.data: unknown field "${key}"`))
      spec.check(event.data, errors, at)
      return errors
    })
  }
}

export const validateCatalog = referenceValidator(CATALOG_EVENT_NAMES)
export const validateCampaigns = referenceValidator(CAMPAIGN_EVENT_NAMES)
export const validateIdentity = referenceValidator(SERVER_IDENTITY_EVENT_NAMES)
