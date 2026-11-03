/**
 * Sends every tracked event to POST /analytics/events. Campaign activity also
 * produces the two events the campaign metrics count:
 *
 *   campaign_impression (a campaign's product shown)  → impression (sent instead)
 *   product_click on a campaign card (opens the       → + click     (an ad click)
 *     product's page)
 *
 * add_to_cart is sent as it is: the backend credits it to this user's latest
 * click on the product in the last 7 days (click-to-basket), so the browser
 * keeps no record of clicks.
 *
 * Sending is the Basketline SDK's (@divya2424/basketline-sdk), the same package vendors install;
 * its failures are logged and never affect the shopper.
 */
import { createBasketline, IDENTITY_EVENTS } from '@divya2424/basketline-sdk'
import { randomEventId } from './analytics.js'
import { getRequestContext } from '../api/requestContext.js'
import { renewShopperToken } from '../features/auth/authService.js'

/** The event as the backend stores it: campaignId/productId/storeId (the seller) as columns, the rest as properties. */
function activity(event) {
  const { campaignId = null, productId = null, storeId = null, ...properties } = event.properties
  return {
    eventId: event.eventId,
    eventName: event.eventName,
    campaignId,
    productId,
    storeId,
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
    storeId: event.properties.storeId ?? null,
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
        ? [base(event, { eventId: event.eventId, eventName: 'impression', productId, properties: { position: event.properties.position, slot: event.properties.slot } })]
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
 * Sends the storefront's events through the Basketline SDK, as any retailer's
 * site does: one client per store, which batches the events and sends them with
 * the right identity. A signed-in customer: their shopper token, which the
 * store's backend got from Basketline with its API key; anyone else (visitors,
 * staff): this browser's visitor. Sign-in and sign-out are picked up from the
 * request context on each event: the SDK then sends login and logout. Sign-in
 * activity (login_click, …) goes through identity(), everything else through track().
 */

/** The customer's shopper token, renewed by the store's backend when it is (nearly) expired. */
async function shopperToken() {
  const { shopper } = getRequestContext()
  if (shopper && Date.parse(shopper.expiresAt) - Date.now() > 60_000) return shopper.token
  return (await renewShopperToken()).token
}
export function createBackendTransport({ apiUrl = import.meta.env.VITE_BASKETLINE_API_URL, createClient = createBasketline, getToken = shopperToken } = {}) {
  const clients = new Map() // tenantId → { sdk, userId }

  function clientFor(tenantId) {
    if (!clients.has(tenantId)) clients.set(tenantId, { sdk: createClient({ apiUrl, tenantId }), userId: null })
    const client = clients.get(tenantId)
    const { shopper } = getRequestContext()
    if (shopper && client.userId !== shopper.userId) {
      // Basketline's ID for the customer. After sign-out, the SDK sends the logout with the token it already has.
      client.sdk.identify({ userId: shopper.userId, getToken })
      client.userId = shopper.userId
    } else if (!shopper && client.userId) {
      client.sdk.reset()
      client.userId = null
    }
    return client.sdk
  }

  return {
    send(event) {
      const sdk = clientFor(getRequestContext().tenantId)
      for (const { eventName, campaignId, productId, storeId, pageName, featureName, properties } of toBackendEvents(event)) {
        if (IDENTITY_EVENTS.includes(eventName)) sdk.identity(eventName, { pageName, featureName, properties })
        else sdk.track(eventName, { campaignId, productId, storeId, pageName, featureName, properties })
      }
    },
    /** Sends what is queued now (tests; the SDK also does it when the page is hidden). */
    flush: () => Promise.all([...clients.values()].map(({ sdk }) => sdk.flush())),
  }
}
