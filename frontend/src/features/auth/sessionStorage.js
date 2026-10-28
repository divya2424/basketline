/**
 * The signed-in session lives in sessionStorage (cleared when the tab closes):
 * profile, role, access token and its expiry, and the tenant the token belongs
 * to. Never the password.
 * Note: script running on the page can read sessionStorage, so the app must
 * stay free of XSS; an httpOnly cookie would avoid that but needs backend support.
 */
import { getRequestContext } from '../../api/requestContext.js'

const SESSION_KEY = 'ecommerce-analytics:session:v3'

export function loadSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null')
    const valid =
      session &&
      typeof session.userId === 'string' &&
      typeof session.accessToken === 'string' &&
      typeof session.role === 'string' &&
      Date.parse(session.expiresAt) > Date.now() &&
      // A token is valid for one tenant only: after switching stores, sign in again.
      session.tenantId === getRequestContext().tenantId
    return valid ? session : null
  } catch {
    return null
  }
}

export function saveSession(session) {
  try {
    if (session) {
      const { userId, username, displayName, role, accessToken, expiresAt } = session
      const { tenantId } = getRequestContext()
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId, username, displayName, role, accessToken, expiresAt, tenantId }))
    } else {
      sessionStorage.removeItem(SESSION_KEY)
    }
  } catch {
    // Storage unavailable: the session lasts until the page is reloaded.
  }
}
