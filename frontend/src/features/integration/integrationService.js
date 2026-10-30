/**
 * A vendor's integration with Basketline: its API keys and allowed websites
 * (auth-service, for its campaign managers; the tenant is the signed-in user's).
 */
import { API_BASE_URL, ApiError, apiRequest } from '../../api/httpClient.js'

/** [{ prefix, name, createdAt, revokedAt }], newest first. Never the keys themselves. */
export async function listApiKeys({ signal } = {}) {
  return (await apiRequest('/auth/api-keys', { signal })).items
}

/** { key, prefix, name, createdAt }: the key is in this response only. */
export function createApiKey(name) {
  return apiRequest('/auth/api-keys', { method: 'POST', body: { name } })
}

export function revokeApiKey(prefix) {
  return apiRequest(`/auth/api-keys/${encodeURIComponent(prefix)}`, { method: 'DELETE' })
}

/** The websites (origins) whose pages may send the store's events; [] means any. */
export async function listAllowedOrigins({ signal } = {}) {
  return (await apiRequest('/auth/allowed-origins', { signal })).origins
}

/** Replaces the list; returns it as saved (normalized, without duplicates). */
export async function setAllowedOrigins(origins) {
  return (await apiRequest('/auth/allowed-origins', { method: 'PUT', body: { origins } })).origins
}

/**
 * The same calls as a given tenant's campaign manager, with their own token,
 * without switching the app to that tenant (the onboarding page's tenant
 * details). The app's HTTP client always sends the current tenant's identity,
 * so these use fetch directly.
 */
export function integrationAs({ tenantId, token }, { baseUrl = API_BASE_URL, fetchImpl = (...args) => fetch(...args) } = {}) {
  const call = async (path, init = {}) => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', tenant_id: tenantId, Authorization: `Bearer ${token}` },
    })
    const body = res.status === 204 ? null : await res.json().catch(() => null)
    if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? `Request failed with status ${res.status}`)
    return body
  }
  return {
    listApiKeys: async () => (await call('/auth/api-keys')).items,
    createApiKey: (name) => call('/auth/api-keys', { method: 'POST', body: JSON.stringify({ name }) }),
    revokeApiKey: (prefix) => call(`/auth/api-keys/${encodeURIComponent(prefix)}`, { method: 'DELETE' }),
    listAllowedOrigins: async () => (await call('/auth/allowed-origins')).origins,
    setAllowedOrigins: async (origins) => (await call('/auth/allowed-origins', { method: 'PUT', body: JSON.stringify({ origins }) })).origins,
  }
}
