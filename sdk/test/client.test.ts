import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBasketline } from '../src/index'
import { CAMPAIGN, fakeApi, memoryStorage, PRODUCT, TENANT, tokenWithExp } from './helpers'

const API = 'https://api.example.com/api/v1/'

afterEach(() => {
  vi.useRealTimers()
})

function client(api = fakeApi(), extra = {}) {
  const errors: string[] = []
  const bl = createBasketline({ apiUrl: API, tenantId: TENANT, fetch: api.fetch, storage: memoryStorage(), onError: (e) => errors.push(e.message), ...extra })
  return { bl, api, errors }
}

describe('batching', () => {
  it('posts 20 events per request, the rest after 2 seconds, with keepalive', async () => {
    vi.useFakeTimers()
    const { bl, api } = client()
    for (let i = 0; i < 25; i++) bl.impression({ campaignId: CAMPAIGN })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.eventCalls().map((c) => c.body.events.length)).toEqual([20])
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.eventCalls().map((c) => c.body.events.length)).toEqual([20, 5])
    expect(api.eventCalls().every((c) => c.keepalive)).toBe(true)
  })

  it('sends what is queued when the page is hidden', async () => {
    const { bl, api } = client()
    bl.track('home_view')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await bl.flush()
    expect(api.eventCalls()).toHaveLength(1)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })
})

describe('identity', () => {
  it("sends a visitor's events with a visitor token for its lasting UUID, reused until shortly before it expires", async () => {
    vi.useFakeTimers()
    const { bl, api } = client()
    bl.track('home_view')
    await bl.flush()
    bl.track('home_view')
    await bl.flush()
    const [first, second] = api.eventCalls()
    expect(first!.body).toMatchObject({ tenantId: TENANT, userId: bl.visitorId, userType: 'visitor' })
    expect(first!.headers.get('Authorization')).toMatch(/visitor-1$/)
    expect(second!.headers.get('Authorization')).toMatch(/visitor-1$/)
    // The visitor asked with its own UUID, for this store.
    const visitorCall = api.calls.find((c) => c.path.endsWith('/auth/visitor'))!
    expect(visitorCall.body).toEqual({ userId: bl.visitorId, clientType: 'web' })
    expect(visitorCall.headers.get('tenant_id')).toBe(TENANT)
    // 26 minutes on, within 5 minutes of the token's 30: a new one.
    vi.setSystemTime(Date.now() + 26 * 60_000)
    bl.track('home_view')
    await bl.flush()
    expect(api.eventCalls()[2]!.headers.get('Authorization')).toMatch(/visitor-2$/)
  })

  it("keeps the visitor's UUID per store in storage", () => {
    const storage = memoryStorage()
    const one = createBasketline({ apiUrl: API, tenantId: TENANT, storage, fetch: fakeApi().fetch })
    const again = createBasketline({ apiUrl: API, tenantId: TENANT, storage, fetch: fakeApi().fetch })
    const other = createBasketline({ apiUrl: API, tenantId: 'aaaaaaaa-0000-4000-8000-000000000000', storage, fetch: fakeApi().fetch })
    expect(one.visitorId).toMatch(/^[0-9a-f-]{36}$/)
    expect(again.visitorId).toBe(one.visitorId)
    expect(other.visitorId).not.toBe(one.visitorId)
  })

  it('sends a signed-in shopper\'s events with their token and ID, and the visitor\'s again after reset', async () => {
    const { bl, api } = client()
    const getToken = vi.fn(async () => tokenWithExp('shopper', Math.floor(Date.now() / 1000) + 1800))
    bl.track('home_view') // queued as the visitor
    bl.identify({ userId: 'ABCDEF00-0000-4000-8000-000000000001', getToken })
    bl.addToCart({ productId: PRODUCT, quantity: 2 })
    bl.addToCart({ productId: PRODUCT })
    await bl.flush()
    bl.reset()
    bl.track('home_view')
    await bl.flush()
    const [asVisitor, asShopper, afterReset] = api.eventCalls()
    expect(asVisitor!.body.userType).toBe('visitor')
    expect(asShopper!.body).toMatchObject({ userId: 'abcdef00-0000-4000-8000-000000000001', userType: 'registered' })
    expect(asShopper!.headers.get('Authorization')).toMatch(/shopper$/)
    expect(asShopper!.body.events[0]).toMatchObject({ eventName: 'add_to_cart', productId: PRODUCT, campaignId: null, properties: { quantity: 2 } })
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(afterReset!.body).toMatchObject({ userId: bl.visitorId, userType: 'visitor' })
  })

  it('gets a fresh token after a 401, once', async () => {
    const statuses = [401, 200]
    const { bl, api } = client(fakeApi(() => statuses.shift() ?? 200))
    let n = 0
    bl.identify({ userId: '00000000-0000-4000-8000-000000000001', getToken: () => `token-${++n}` })
    bl.track('home_view')
    await bl.flush()
    expect(api.eventCalls().map((c) => c.headers.get('Authorization'))).toEqual(['Bearer token-1', 'Bearer token-2'])
  })
})

describe('delivery', () => {
  it('retries a 5xx or 429 once, honouring Retry-After, then reports it', async () => {
    vi.useFakeTimers()
    const statuses = [503, 200, 429, 429]
    const { bl, api, errors } = client(fakeApi(() => {
      const status = statuses.shift() ?? 200
      return status === 429 ? new Response('{}', { status, headers: { 'Retry-After': '3' } }) : status
    }))
    bl.track('home_view')
    const first = bl.flush()
    await vi.advanceTimersByTimeAsync(1000)
    await first
    expect(api.eventCalls()).toHaveLength(2)
    expect(errors).toEqual([])
    bl.track('home_view')
    const second = bl.flush()
    await vi.advanceTimersByTimeAsync(2999)
    expect(api.eventCalls()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(api.eventCalls()).toHaveLength(4)
    expect(errors).toEqual(['1 events not sent (429)'])
  })

  it('never throws into the page: a failing network, a failing token and a failing onError are all contained', async () => {
    const broken = vi.fn(async () => {
      throw new TypeError('offline')
    })
    const bl = createBasketline({ apiUrl: API, tenantId: TENANT, fetch: broken as unknown as typeof fetch, storage: memoryStorage(), onError: () => {
      throw new Error('bad handler')
    } })
    vi.useFakeTimers()
    expect(() => bl.track('home_view')).not.toThrow()
    const done = bl.flush()
    await vi.advanceTimersByTimeAsync(2000)
    await expect(done).resolves.toBeUndefined()
    bl.identify({ userId: '00000000-0000-4000-8000-000000000001', getToken: () => Promise.reject(new Error('no token')) })
    bl.track('home_view')
    const shopperDone = bl.flush()
    await vi.advanceTimersByTimeAsync(2000)
    await expect(shopperDone).resolves.toBeUndefined()
  })
})

describe('validation', () => {
  it('drops invalid events and personal-looking properties, and reports why', async () => {
    const { bl, api, errors } = client()
    expect(bl.impression({ campaignId: 'not-a-uuid' })).toBeNull()
    expect(bl.track('purchase' as never)).toBeNull()
    expect(bl.click({ campaignId: CAMPAIGN, productId: 'nope' })).toBeNull()
    const id = bl.click({ campaignId: CAMPAIGN, productId: PRODUCT, properties: { position: 1, email: 'a@b.c' } })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    await bl.flush()
    expect(api.eventCalls()[0]!.body.events).toEqual([
      expect.objectContaining({ eventId: id, eventName: 'click', campaignId: CAMPAIGN, productId: PRODUCT, properties: { position: 1 } }),
    ])
    expect(errors).toHaveLength(4)
    expect(errors.at(-1)).toBe('properties dropped (personal data): email')
  })
})
