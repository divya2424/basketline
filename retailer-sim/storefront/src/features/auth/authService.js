/**
 * Sign-in against the store's own auth service (the retailer's, not Basketline's).
 * The session holds the store's token, which the API client sends to the store's
 * services, and for a customer their Basketline shopper token, which the
 * Basketline SDK sends their events with.
 */
import { apiRequest } from '../../api/httpClient.js'
import { getRequestContext, setShopper } from '../../api/requestContext.js'

export class AuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthError'
  }
}

const LOGIN_MESSAGES = {
  401: 'Invalid username or password.',
  404: 'This store isn’t set up yet.',
  429: 'Too many sign-in attempts. Try again in a few minutes.',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The Basketline SDK's visitor ID for this store (bl.visitorId, kept in localStorage): signed in, the customer stays that person. */
function visitorId(tenantId) {
  try {
    const id = localStorage.getItem(`basketline:anonymous-id:${tenantId}`)
    return UUID.test(id ?? '') ? id : undefined
  } catch {
    return undefined
  }
}

/** { userId, shopperToken, expiresIn } from the store's backend → the session's shopper. */
const toShopper = (basketline) =>
  basketline ? { userId: basketline.userId, token: basketline.shopperToken, expiresAt: new Date(Date.now() + basketline.expiresIn * 1000).toISOString() } : null

/** Returns { userId, username, displayName, role, accessToken, expiresAt, shopper }; shopper: a customer's Basketline identity, else null. */
export async function authenticate(username, password) {
  try {
    const result = await apiRequest('/auth/login', {
      method: 'POST',
      body: { username: username.trim(), password, clientType: 'web', visitorId: visitorId(getRequestContext().tenantId) },
    })
    return {
      userId: result.user.id,
      username: result.user.username,
      displayName: result.user.username,
      role: result.user.role,
      accessToken: result.accessToken,
      expiresAt: result.session.expiresAt,
      shopper: toShopper(result.basketline),
    }
  } catch (error) {
    throw new AuthError(LOGIN_MESSAGES[error.status] ?? error.message ?? 'Sign-in failed. Try again.')
  }
}

/** A fresh shopper token from the store's backend, for the SDK; the session keeps it. */
export async function renewShopperToken() {
  const shopper = toShopper(await apiRequest('/auth/shopper-token', { method: 'POST', body: { clientType: 'web' } }))
  setShopper(shopper)
  return shopper
}
