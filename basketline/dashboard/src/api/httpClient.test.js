import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiRequest, setUnauthorizedHandler } from './httpClient.js'
import { DEFAULT_TENANT_ID, setRequestTenant, setRequestUser } from './requestContext.js'
import { createAnalyticsApi } from '../features/analytics/analyticsService.js'
import { jsonResponse, mockFetch } from '../test/mockFetch.js'

const ok = () => jsonResponse(200, { count: 1 })
let api
afterEach(() => {
  api?.restore()
  setRequestUser(null)
  setRequestTenant(DEFAULT_TENANT_ID)
})

describe('apiRequest (axios)', () => {
  it('sends tenant_id on every request and omits user_id when signed out', async () => {
    api = mockFetch(ok)
    await expect(apiRequest('/x')).resolves.toEqual({ count: 1 })
    expect(api.requests[0].url).toBe('http://api.test/x')
    expect(api.requests[0].headers.get('tenant_id')).toBe(DEFAULT_TENANT_ID)
    expect(api.requests[0].headers.has('user_id')).toBe(false)
    expect(api.requests[0].headers.has('authorization')).toBe(false)
  })

  it('sends user_id and the bearer token when signed in, with a JSON body', async () => {
    setRequestUser({ userId: 'user_1001', accessToken: 'token-1' })
    setRequestTenant('tenant_acme')
    api = mockFetch(ok)
    await apiRequest('/x', { method: 'POST', body: { a: 1 }, keepalive: true })
    const [request] = api.requests
    expect(request).toMatchObject({ method: 'POST', body: { a: 1 }, keepalive: true })
    expect(request.headers.get('tenant_id')).toBe('tenant_acme')
    expect(request.headers.get('user_id')).toBe('user_1001')
    expect(request.headers.get('authorization')).toBe('Bearer token-1')
    expect(request.headers.get('accept')).toBe('application/json')
  })

  it('reads the identity at request time, so sign-out takes effect immediately', async () => {
    api = mockFetch(ok)
    setRequestUser({ userId: 'user_1001' })
    await apiRequest('/x')
    setRequestUser(null)
    await apiRequest('/x')
    expect(api.requests[0].headers.get('user_id')).toBe('user_1001')
    expect(api.requests[1].headers.has('user_id')).toBe(false)
  })

  it('turns error responses into ApiError, and signs out on a 401 when a token was sent', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    api = mockFetch(() => jsonResponse(401, { error: { code: 'TOKEN_EXPIRED', message: 'Expired', details: { a: 1 } } }))
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 401, code: 'TOKEN_EXPIRED', message: 'Expired' })
    expect(onUnauthorized).not.toHaveBeenCalled()
    setRequestUser({ userId: 'user_1001', accessToken: 'token-1' })
    const error = await apiRequest('/x').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.details).toEqual({ a: 1 })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    setUnauthorizedHandler(() => {})
  })

  it('reports an unreachable server as NETWORK_ERROR', async () => {
    api = mockFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' })
  })
})

describe('API clients use apiRequest', () => {
  it('adds identity headers to the three campaign metric requests', async () => {
    setRequestUser({ userId: 'user_1001' })
    api = mockFetch(ok)
    const metrics = createAnalyticsApi({ baseUrl: 'https://api.test' })
    await Promise.all(['clicks', 'impressions', 'clickToBasket'].map((metric) => metrics.fetchMetric('campaign_001', metric)))
    for (const request of api.requests) {
      expect(request.headers.get('tenant_id')).toBe(DEFAULT_TENANT_ID)
      expect(request.headers.get('user_id')).toBe('user_1001')
    }
    expect(api.requests).toHaveLength(3)
  })
})
