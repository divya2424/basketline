import axios from 'axios'
import { getRequestContext } from './requestContext.js'

/** e.g. http://localhost:8080/api/v1 (the API gateway). */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')

// Header names requested by the backend. Note: nginx drops headers containing
// underscores unless `underscores_in_headers on;` is set, and cross-origin
// APIs must list both in Access-Control-Allow-Headers.
export const TENANT_HEADER = 'tenant_id'
export const USER_HEADER = 'user_id'

/** Headers identifying the tenant and (when signed in) the user. */
export function identityHeaders() {
  const { tenantId, userId, accessToken } = getRequestContext()
  const headers = { [TENANT_HEADER]: tenantId }
  if (userId) headers[USER_HEADER] = userId
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  return headers
}

/**
 * The axios instance used for every API call. Each request gets the identity
 * headers (tenant, user, bearer token) on top of any headers the caller passes.
 * The fetch adapter is used so analytics events can be sent with `keepalive`.
 */
export const http = axios.create({ baseURL: API_BASE_URL, adapter: 'fetch', headers: { Accept: 'application/json' } })

http.interceptors.request.use((config) => {
  for (const [name, value] of Object.entries(identityHeaders())) config.headers.set(name, value)
  return config
})

/** An error response from the API: { error: { code, message, details } }. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

let onUnauthorized = () => {}
/** Called when a request made with a token gets 401 (token expired or session revoked). */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler
}

/**
 * JSON request to the API gateway. Resolves with the parsed body; rejects with
 * ApiError (status 0 / NETWORK_ERROR when the server can't be reached).
 * `baseUrl` is for tests and non-default deployments. `headers` are sent too, but
 * the identity headers (and a signed-in user's token) take precedence.
 */
export async function apiRequest(path, { method = 'GET', body, signal, keepalive, baseUrl, headers } = {}) {
  const hadToken = Boolean(getRequestContext().accessToken)
  try {
    const response = await http.request({
      url: path,
      method,
      data: body,
      headers,
      signal,
      ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
      ...(keepalive ? { fetchOptions: { keepalive: true } } : {}),
    })
    return response.status === 204 ? null : response.data
  } catch (error) {
    if (axios.isCancel(error)) throw error
    const { response } = error
    if (!response) throw new ApiError(0, 'NETWORK_ERROR', 'Can’t reach the server. Check your connection and try again.')
    if (response.status === 401 && hadToken) onUnauthorized()
    const details = response.data?.error ?? {}
    throw new ApiError(response.status, details.code ?? 'HTTP_ERROR', details.message ?? `Request failed with status ${response.status}`, details.details)
  }
}
