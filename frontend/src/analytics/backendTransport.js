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
 * Sending is the Basketline SDK's (sdk/), the same package vendors install;
 * its failures are logged and never affect the shopper.
 */
import { createBasketline } from '@basketline/sdk'
import { randomEventId } from './analytics.js'
import { getRequestContext } from '../api/requestContext.js'

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
 * Sends the storefront's events through the Basketline SDK (sdk/), as any
 * vendor's site does: one client per store, which batches the events and sends
 * them with the right identity. Signed in, the user's access token (Basketline
 * users' tokens are accepted for events); signed out, this browser's visitor.
 * Sign-in and sign-out are picked up from the request context on each event.
 */
export function createBackendTransport({ apiUrl = import.meta.env.VITE_API_BASE_URL, createClient = createBasketline } = {}) {
  const clients = new Map() // tenantId → { sdk, userId }

  function clientFor(tenantId) {
    if (!clients.has(tenantId)) clients.set(tenantId, { sdk: createClient({ apiUrl, tenantId }), userId: null })
    const client = clients.get(tenantId)
    const { userId, accessToken } = getRequestContext()
    if (accessToken && client.userId !== userId) {
      client.sdk.identify({ userId, getToken: () => getRequestContext().accessToken })
      client.userId = userId
    } else if (!accessToken && client.userId) {
      client.sdk.reset()
      client.userId = null
    }
    return client.sdk
  }

  return {
    send(event) {
      const sdk = clientFor(getRequestContext().tenantId)
      for (const { eventName, campaignId, productId, pageName, featureName, properties } of toBackendEvents(event)) {
        sdk.track(eventName, { campaignId, productId, pageName, featureName, properties })
      }
    },
    /** Sends what is queued now (tests; the SDK also does it when the page is hidden). */
    flush: () => Promise.all([...clients.values()].map(({ sdk }) => sdk.flush())),
  }
}
