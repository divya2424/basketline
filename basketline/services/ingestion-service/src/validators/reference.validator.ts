import { isIsoDate, isNonEmptyString, isOneOf, isPlainObject, isUuid, unknownKeys } from '@basketline/platform'
import { CAMPAIGN_EVENT_NAMES, CAMPAIGN_PRODUCT_EVENT_NAMES, CATALOG_EVENT_NAMES, isStoreRecordId, SERVER_IDENTITY_EVENT_NAMES } from '@basketline/contracts'

export const MAX_REFERENCE_EVENTS_PER_REQUEST = 500
const STATUSES = ['draft', 'active', 'paused', 'completed']

/** One update from the store's server: its name, when the state is from (default: now), and the state. */
export interface IncomingReferenceEvent {
  eventName: string
  updatedAt?: string
  data: Record<string, unknown>
}

const id = (data: Record<string, unknown>, field: string, errors: string[], at: string) => {
  if (!isStoreRecordId(data[field])) errors.push(`${at}.data.${field} must be an ID (a UUID or your own, up to 128 characters)`)
}

/** Field checks per event name; a store's own IDs are mapped later (externalId). */
const optionalId = (data: Record<string, unknown>, field: string, errors: string[], at: string) => {
  if (data[field] != null) id(data, field, errors, at)
}
const price = (data: Record<string, unknown>, field: string, errors: string[], at: string) => {
  if (data[field] != null && !(typeof data[field] === 'number' && data[field] >= 0)) errors.push(`${at}.data.${field} must be a number ≥ 0`)
}
const category = (data: Record<string, unknown>, errors: string[], at: string) => {
  if (data.category != null && !isNonEmptyString(data.category, 100)) errors.push(`${at}.data.category must be a string (max 100 characters)`)
}

const DATA: Record<string, { fields: string[]; check: (data: Record<string, unknown>, errors: string[], at: string) => void }> = {
  seller_upserted: {
    fields: ['sellerId', 'name'],
    check: (d, e, at) => { id(d, 'sellerId', e, at); if (!isNonEmptyString(d.name, 200)) e.push(`${at}.data.name must be a string (max 200 characters)`) },
  },
  product_upserted: {
    fields: ['productId', 'storeId', 'sellerId', 'name', 'category', 'price', 'isActive'],
    check: (d, e, at) => {
      id(d, 'productId', e, at)
      optionalId(d, 'storeId', e, at)
      // Optional: without one, the product is the tenant's own (first-party).
      optionalId(d, 'sellerId', e, at)
      if (!isNonEmptyString(d.name, 300)) e.push(`${at}.data.name must be a string (max 300 characters)`)
      category(d, e, at)
      price(d, 'price', e, at)
      if (d.isActive != null && typeof d.isActive !== 'boolean') e.push(`${at}.data.isActive must be true or false`)
    },
  },
  product_removed: { fields: ['productId'], check: (d, e, at) => id(d, 'productId', e, at) },
  campaign_upserted: {
    fields: ['campaignId', 'storeId', 'sellerId', 'placement', 'title', 'status', 'startTime', 'endTime', 'archived', 'productIds'],
    check: (d, e, at) => {
      id(d, 'campaignId', e, at)
      optionalId(d, 'storeId', e, at)
      id(d, 'sellerId', e, at)
      if (d.placement != null && !isNonEmptyString(d.placement, 64)) e.push(`${at}.data.placement must be a string (max 64 characters)`)
      if (!isNonEmptyString(d.title, 200)) e.push(`${at}.data.title must be a string (max 200 characters)`)
      if (!isOneOf(d.status, STATUSES)) e.push(`${at}.data.status must be one of ${STATUSES.join(', ')}`)
      for (const field of ['startTime', 'endTime']) if (d[field] != null && !isIsoDate(d[field])) e.push(`${at}.data.${field} must be an ISO 8601 date-time`)
      if (d.archived != null && typeof d.archived !== 'boolean') e.push(`${at}.data.archived must be true or false`)
      if (!Array.isArray(d.productIds) || d.productIds.length > 500 || !d.productIds.every(isStoreRecordId)) e.push(`${at}.data.productIds must be a list of up to 500 product IDs`)
    },
  },
  campaign_removed: { fields: ['campaignId'], check: (d, e, at) => id(d, 'campaignId', e, at) },
  campaign_product_added: {
    fields: ['campaignId', 'productId', 'storeId', 'sellerId', 'productName', 'productPrice', 'category'],
    check: (d, e, at) => {
      id(d, 'campaignId', e, at)
      id(d, 'productId', e, at)
      optionalId(d, 'storeId', e, at)
      optionalId(d, 'sellerId', e, at)
      if (!isNonEmptyString(d.productName, 300)) e.push(`${at}.data.productName must be a string (max 300 characters)`)
      price(d, 'productPrice', e, at)
      category(d, e, at)
    },
  },
  campaign_product_removed: { fields: ['campaignId', 'productId'], check: (d, e, at) => { id(d, 'campaignId', e, at); id(d, 'productId', e, at) } },
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
export const validateCampaigns = referenceValidator([...CAMPAIGN_EVENT_NAMES, ...CAMPAIGN_PRODUCT_EVENT_NAMES])
export const validateIdentity = referenceValidator(SERVER_IDENTITY_EVENT_NAMES)
