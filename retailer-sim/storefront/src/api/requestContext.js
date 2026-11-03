/**
 * Identity attached to every API request and analytics event.
 *
 *   tenantId     the marketplace's tenant (a UUID): the one last visited from the
 *                Marketplaces page (kept in localStorage), else VITE_TENANT_ID (always set)
 *   tenantName   that tenant's name, shown as the header's brand
 *   userId       the signed-in user's ID at the store, or null for visitors
 *   accessToken  the signed-in user's token from the store's auth service, sent as Authorization: Bearer …
 *   shopper      a signed-in customer's Basketline identity, for the SDK: { userId, token, expiresAt },
 *                from the store's backend; null for visitors and staff (their events go as the visitor)
 *
 * AuthProvider updates the user synchronously on sign-in, sign-out and
 * session restore, so the very first request after a reload is authenticated.
 */
export const DEFAULT_TENANT_ID = '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01'
const TENANT_KEY = 'basketline:tenant'
const TENANT_NAME_KEY = 'basketline:tenant-name'

function saved(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const context = {
  tenantId: saved(TENANT_KEY) || import.meta.env.VITE_TENANT_ID || DEFAULT_TENANT_ID,
  tenantName: saved(TENANT_NAME_KEY),
  userId: null,
  accessToken: null,
  shopper: null,
}

export function getRequestContext() {
  return { ...context }
}

export function setRequestUser(user) {
  context.userId = user?.userId ?? null
  context.accessToken = user?.accessToken ?? null
  context.shopper = user?.shopper ?? null
}

/** A renewed shopper token for the signed-in customer. */
export function setShopper(shopper) {
  context.shopper = shopper
}

/** Tests and multi-tenant setups can override the tenant. */
export function setRequestTenant(tenantId) {
  context.tenantId = tenantId || DEFAULT_TENANT_ID
}

/** Makes `tenantId` (named `tenantName`) the store's tenant, now and after a reload. */
export function switchTenant(tenantId, tenantName = null) {
  try {
    localStorage.setItem(TENANT_KEY, tenantId)
    if (tenantName) localStorage.setItem(TENANT_NAME_KEY, tenantName)
    else localStorage.removeItem(TENANT_NAME_KEY)
  } catch {
    // Storage unavailable: the switch lasts until the page is reloaded.
  }
  setRequestTenant(tenantId)
  context.tenantName = tenantName
}
