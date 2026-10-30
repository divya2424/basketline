/**
 * @basketline/sdk: send ad and shopper events to Basketline from any website.
 *
 *   const bl = createBasketline({ apiUrl, tenantId })
 *   bl.impression({ campaignId }); bl.click({ campaignId, productId }); bl.addToCart({ productId })
 *   bl.identify({ userId, getToken })   // after sign-in, with a shopper token from your backend
 *
 * See README.md.
 */
export { BasketlineError, createBasketline, type Basketline, type BasketlineOptions, type Identify } from './client'
export { ACTIVITY_EVENTS, EVENT_NAMES, METRIC_EVENTS, type EventFields, type EventName } from './events'
export type { KeyValueStorage } from './identity'
