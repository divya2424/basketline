/**
 * Tenant onboarding API (auth-service, through the gateway; no sign-in needed).
 * Every onboarded tenant gets an "onboarding" campaign manager and, if asked,
 * ten standard users user01–user10, all with the password "test".
 */
import { API_BASE_URL, ApiError, apiRequest } from '../../api/httpClient.js'

export const ONBOARDING_USERNAME = 'onboarding'
export const DEMO_PASSWORD = 'test'

export const TIERS = [
  { id: 'free', label: 'Free' },
  { id: 'pro', label: 'Pro' },
  { id: 'enterprise', label: 'Enterprise' },
]

/** [{ tenantId, name, tier, createdAt }], newest first. */
export async function listAccounts({ signal } = {}) {
  return (await apiRequest('/accounts', { signal })).items
}

/** The server generates the tenant ID. Resolves with { account, users: [{ username, role }], password }. */
export function onboardTenant({ name, tier, dummyUsers }) {
  return apiRequest('/accounts', { method: 'POST', body: { name, tier, dummyUsers } })
}

/**
 * Signs in to a tenant as its onboarding campaign manager, without switching the
 * app to it: the token for its details (API keys). Uses fetch directly, since
 * the app's HTTP client sends the current tenant's identity.
 */
export async function managerTokenFor(tenantId, { baseUrl = API_BASE_URL, fetchImpl = (...args) => fetch(...args) } = {}) {
  const res = await fetchImpl(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', tenant_id: tenantId },
    body: JSON.stringify({ username: ONBOARDING_USERNAME, password: DEMO_PASSWORD, clientType: 'web' }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? `Request failed with status ${res.status}`)
  return body.accessToken
}

/** Deletes a tenant and all of its data, everywhere. confirmName: its name, typed again. */
export function deleteTenant(tenantId, confirmName) {
  return apiRequest(`/accounts/${encodeURIComponent(tenantId)}`, { method: 'DELETE', body: { confirmName } })
}
