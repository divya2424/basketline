/**
 * Sign-in against the auth service (through the API gateway). The returned
 * session holds the JWT, which the API client sends with every request.
 */
import { apiRequest } from '../../api/httpClient.js'

/** Role names used by the backend. */
export const ROLES = Object.freeze({
  CAMPAIGN_MANAGER: 'campaign-manager',
  // One seller's user: sees only that seller's campaigns (the API enforces it).
  SELLER_MANAGER: 'seller-manager',
  CUSTOMER: 'standard-user',
})

export const ROLE_LABELS = {
  [ROLES.CAMPAIGN_MANAGER]: 'Campaign manager',
  [ROLES.SELLER_MANAGER]: 'Seller manager',
  [ROLES.CUSTOMER]: 'Customer',
}

export class AuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthError'
  }
}

const LOGIN_MESSAGES = {
  401: 'Invalid username or password.',
  403: 'This account is disabled.',
  429: 'Too many sign-in attempts. Try again in a few minutes.',
}

/** Returns { userId, username, displayName, role, sellerId, accessToken, expiresAt }; sellerId is a seller manager's seller, else null. */
export async function authenticate(username, password) {
  try {
    const result = await apiRequest('/auth/login', {
      method: 'POST',
      body: { username: username.trim(), password, clientType: 'web' },
    })
    return {
      userId: result.user.id,
      username: result.user.username,
      displayName: result.user.username,
      role: result.user.role,
      sellerId: result.user.sellerId ?? null,
      accessToken: result.accessToken,
      expiresAt: result.session.expiresAt,
    }
  } catch (error) {
    throw new AuthError(LOGIN_MESSAGES[error.status] ?? error.message ?? 'Sign-in failed. Try again.')
  }
}

/** Ends the session on the server (records the logout time). Never throws. */
export async function endSession() {
  try {
    await apiRequest('/auth/logout', { method: 'POST' })
  } catch {
    // Already expired or revoked, or offline: the local sign-out still happens.
  }
}
