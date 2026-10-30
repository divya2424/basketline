/**
 * Sends every tracked event to POST /analytics/events. Campaign activity also
 * produces the two events the campaign metrics count:
 *
 *   campaign_impression (carousel slide shown)        → impression (sent instead)
 *   product_click on a campaign card (opens the       → + click     (an ad click)
 *     product's page)
 *
 * add_to_cart is sent as it is: the backend credits it to this user's latest
 * click on the product in the last 7 days (click-to-basket), so the browser
 * keeps no record of clicks.
 *
 * Failures are reported by trackEvent and never affect the shopper.
 */
import { randomEventId } from './analytics.js'
import { apiRequest } from '../api/httpClient.js'
import { getRequestContext } from '../api/requestContext.js'

/** Visitor tokens last 30 minutes; a new one is fetched a little before. */
export const VISITOR_TOKEN_RENEW_MS = 25 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** IDs for stores whose ID can't be kept in localStorage (private mode): kept for this page. */
const pageIds = new Map()

/**
 * This browser's lasting visitor UUID for one store (tenant): the userId of its
 * events while not signed in, so a visitor counts as one customer across visits.
 * One per store, so stores can't link a shopper.
 */
export function anonymousId(tenantId) {
  const key = `basketline:anonymous-id:${tenantId}`
  try {
    const stored = localStorage.getItem(key)
    if (UUID.test(stored ?? '')) return stored
    const id = randomEventId()
    localStorage.setItem(key, id)
    return id
  } catch {
    if (!pageIds.has(tenantId)) pageIds.set(tenantId, randomEventId())
    return pageIds.get(tenantId)
  }
}

/** A visitor token for this browser's visitor UUID in the store: { userId, token }. */
export async function requestVisitorToken(tenantId, request = apiRequest) {
  const userId = anonymousId(tenantId)
  const body = await request('/auth/visitor', { method: 'POST', body: { userId, clientType: 'web' } })
  return { userId, token: body.visitorToken }
}

/** The event as the backend stores it: campaignId/productId as columns, the rest as properties. */
function activity(event) {
  const { campaignId = null, productId = null, ...properties } = event.properties
  return {
    eventId: event.eventId,
    eventName: event.eventName,
    campaignId,
    productId,
    timestamp: event.timestamp,
    pageName: event.pageName,
    featureName: event.featureName,
    properties,
  }
}

function base(event, extra) {
  return {
    eventId: randomEventId(),
    campaignId: event.properties.campaignId,
    timestamp: event.timestamp,
    pageName: event.pageName,
    featureName: event.featureName,
    ...extra,
  }
}

/** Frontend event → the backend events to send. Exported for tests. */
export function toBackendEvents(event) {
  const { campaignId, productId } = event.properties
  switch (event.eventName) {
    case 'campaign_impression':
      return campaignId
        ? [base(event, { eventId: event.eventId, eventName: 'impression', properties: { position: event.properties.position } })]
        : []

    case 'product_click': {
      if (!campaignId || !productId) return [activity(event)]
      return [activity(event), base(event, { eventName: 'click', productId })]
    }

    default:
      return [activity(event)]
  }
}

/**
 * Posts a batch of events, with the tenant, user and user type its token was
 * issued for: the backend rejects a batch whose identity doesn't match its
 * token. A signed-in user's access token is used as is (registered); a visitor
 * gets a visitor token for its UUID in the store (POST /auth/visitor), reused
 * until shortly before it expires.
 */
export function createEventSender(request = apiRequest) {
  let visitor = null // { tenantId, renewAt, visit: Promise<{ userId, token }> }

  function visitorToken(tenantId) {
    if (visitor?.tenantId !== tenantId || visitor.renewAt <= Date.now()) {
      const visit = requestVisitorToken(tenantId, request)
      visitor = { tenantId, renewAt: Date.now() + VISITOR_TOKEN_RENEW_MS, visit }
      // A failed request is retried with the next batch.
      visit.catch(() => {
        if (visitor?.visit === visit) visitor = null
      })
    }
    return visitor.visit
  }

  return async (events) => {
    const { tenantId, userId, accessToken } = getRequestContext()
    // Signed in: the HTTP client adds the access token.
    if (accessToken) {
      return request('/analytics/events', { method: 'POST', body: { tenantId, userId, userType: 'registered', events }, keepalive: true })
    }
    const visit = await visitorToken(tenantId)
    return request('/analytics/events', {
      method: 'POST',
      body: { tenantId, userId: visit.userId, userType: 'visitor', events },
      keepalive: true,
      headers: { Authorization: `Bearer ${visit.token}` },
    })
  }
}

/**
 * Queues events and posts them in batches: when `batchSize` are queued, `flushAfterMs`
 * after the first one, or when the page is hidden. The gateway rate-limits event
 * requests per IP, so one request per event would drop events for busy pages and
 * shared IPs. Each send() returns the promise of the request that carries its events.
 */
export function createBackendTransport({
  send = createEventSender(),
  batchSize = 20,
  flushAfterMs = 2000,
} = {}) {
  let queue = []
  let delivered = null
  let settle
  let timer

  function flush() {
    clearTimeout(timer)
    timer = undefined
    if (queue.length === 0) return
    send(queue).then(settle.resolve, settle.reject)
    queue = []
    delivered = null
  }

  if (typeof document !== 'undefined') {
    // keepalive lets this last request finish while the page unloads.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }

  return {
    send(event) {
      const events = toBackendEvents(event)
      if (events.length === 0) return undefined
      delivered ??= new Promise((resolve, reject) => {
        settle = { resolve, reject }
      })
      const result = delivered
      queue.push(...events)
      if (queue.length >= batchSize) flush()
      else timer ??= setTimeout(flush, flushAfterMs)
      return result
    },
  }
}
