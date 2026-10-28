/**
 * Sends every tracked event to POST /analytics/events. Campaign activity also
 * produces the three events the campaign metrics count:
 *
 *   campaign_impression (carousel slide shown)        → impression (sent instead)
 *   product_click on a campaign card (opens the       → + click     (an ad click)
 *     product's page)
 *   add_to_cart of a product clicked in a campaign    → + click_to_basket, credited
 *     within 24h (same browser session)                   to that click; without a
 *                                                          click, no metric event
 *
 * Failures are reported by trackEvent and never affect the shopper.
 */
import { randomEventId } from './analytics.js'
import { apiRequest } from '../api/httpClient.js'
import { getRequestContext } from '../api/requestContext.js'
import { createAttributionStore } from './attributionStore.js'

/** Visitor tokens last 30 minutes; a new one is fetched a little before. */
export const VISITOR_TOKEN_RENEW_MS = 25 * 60 * 1000

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
export function toBackendEvents(event, attribution) {
  const { campaignId, productId } = event.properties
  switch (event.eventName) {
    case 'campaign_impression':
      return campaignId
        ? [base(event, { eventId: event.eventId, eventName: 'impression', properties: { position: event.properties.position } })]
        : []

    case 'product_click': {
      if (!campaignId || !productId) return [activity(event)]
      const click = base(event, { eventName: 'click', productId })
      attribution.recordClick({ clickId: click.eventId, campaignId, productId, at: event.timestamp })
      return [activity(event), click]
    }

    case 'add_to_cart': {
      if (!productId) return [activity(event)]
      const out = [activity(event)]
      const click = attribution.takeClick(productId, event.timestamp)
      if (click) {
        out.push(base(event, { eventName: 'click_to_basket', campaignId: click.campaignId, productId, attributionId: click.clickId }))
      }
      return out
    }

    default:
      return [activity(event)]
  }
}

/**
 * Posts a batch of events. A signed-in user's access token is used as is; an
 * anonymous visitor gets a visitor token for the store's tenant (POST
 * /auth/visitor), reused until shortly before it expires. The backend takes the
 * tenant and user from the token, so events can't be sent for another tenant.
 */
export function createEventSender(request = apiRequest) {
  let visitor = null // { tenantId, renewAt, token: Promise<string> }

  function visitorToken(tenantId) {
    if (visitor?.tenantId !== tenantId || visitor.renewAt <= Date.now()) {
      const token = request('/auth/visitor', { method: 'POST' }).then((body) => body.visitorToken)
      visitor = { tenantId, renewAt: Date.now() + VISITOR_TOKEN_RENEW_MS, token }
      // A failed request is retried with the next batch.
      token.catch(() => {
        if (visitor?.token === token) visitor = null
      })
    }
    return visitor.token
  }

  return async (events) => {
    const { tenantId, accessToken } = getRequestContext()
    const headers = accessToken ? undefined : { Authorization: `Bearer ${await visitorToken(tenantId)}` }
    return request('/analytics/events', { method: 'POST', body: { events }, keepalive: true, headers })
  }
}

/**
 * Queues events and posts them in batches: when `batchSize` are queued, `flushAfterMs`
 * after the first one, or when the page is hidden. The gateway rate-limits event
 * requests per IP, so one request per event would drop events for busy pages and
 * shared IPs. Each send() returns the promise of the request that carries its events.
 */
export function createBackendTransport({
  attribution = createAttributionStore(),
  send = createEventSender(),
  batchSize = 20,
  flushAfterMs = 1000,
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
      const events = toBackendEvents(event, attribution)
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
