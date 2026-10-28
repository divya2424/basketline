/**
 * Identity attached to every API request and analytics event.
 *
 *   tenantId     the store's tenant (a UUID): the one last opened from the onboarding
 *                page (localStorage), else VITE_TENANT_ID (always set)
 *   tenantName   that tenant's name, shown as the header's brand inside the store
 *   userId       the signed-in user's ID, or null for anonymous visitors
 *   accessToken  the signed-in user's JWT, sent as Authorization: Bearer …
 *
 * AuthProvider updates the user synchronously on sign-in, sign-out and
 * session restore, so the very first request after a reload is authenticated.
 */
export const DEFAULT_TENANT_ID = '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01'
const TENANT_KEY = 'ecommerce-analytics:tenant'
const TENANT_NAME_KEY = 'ecommerce-analytics:tenant-name'

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
}

export function getRequestContext() {
  return { ...context }
}

export function setRequestUser(user) {
  context.userId = user?.userId ?? null
  context.accessToken = user?.accessToken ?? null
}

/** Tests and multi-tenant setups can override the tenant. */
export function setRequestTenant(tenantId) {
  context.tenantId = tenantId || DEFAULT_TENANT_ID
}

/** Makes `tenantId` (named `tenantName`) the store's tenant, now and after a reload (the onboarding page's buttons). */
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
