import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createEvent, localCollector, setTransport } from './analytics.js'
import { anonymousId, createBackendTransport, createEventSender, toBackendEvents, VISITOR_TOKEN_RENEW_MS } from './backendTransport.js'
import { setRequestTenant, setRequestUser } from '../api/requestContext.js'
import { createTeeTransport } from './eventTransport.js'
import { renderApp } from '../test/utils.jsx'

const CAMPAIGN = '11111111-aaaa-4aaa-8aaa-111111111111'
const PRODUCT = '22222222-bbbb-4bbb-8bbb-222222222222'

const frontendEvent = (eventName, properties, featureName = 'product_card') =>
  createEvent({ featureName, pageName: 'home', eventName, properties })

describe('toBackendEvents', () => {
  it('turns a campaign impression into an impression', () => {
    const event = frontendEvent('campaign_impression', { campaignId: CAMPAIGN, productIds: [PRODUCT], position: 1 }, 'campaign_carousel')
    expect(toBackendEvents(event)).toEqual([
      {
        eventId: event.eventId,
        campaignId: CAMPAIGN,
        eventName: 'impression',
        timestamp: event.timestamp,
        pageName: 'home',
        featureName: 'campaign_carousel',
        properties: { position: 1 },
      },
    ])
  })

  it('counts opening a campaign card as an ad click, with the product the backend credits a later add to cart to', () => {
    const details = frontendEvent('product_click', { campaignId: CAMPAIGN, productId: PRODUCT, source: 'home_carousel' })
    const [activity, click] = toBackendEvents(details)
    expect(activity).toMatchObject({ eventId: details.eventId, eventName: 'product_click', campaignId: CAMPAIGN, productId: PRODUCT })
    expect(click).toMatchObject({ eventName: 'click', campaignId: CAMPAIGN, productId: PRODUCT })
    expect(click.eventId).not.toBe(details.eventId)

    // Added later from the catalog grid (no campaign on that card): sent as is.
    const add = frontendEvent('add_to_cart', { productId: PRODUCT, quantity: 1, source: 'catalog_grid' })
    expect(toBackendEvents(add)).toEqual([expect.objectContaining({ eventId: add.eventId, eventName: 'add_to_cart', campaignId: null, productId: PRODUCT, properties: { quantity: 1, source: 'catalog_grid' } })])
  })

  it('does not count Add to cart on a campaign card as an ad click', () => {
    const add = frontendEvent('add_to_cart', { campaignId: CAMPAIGN, productId: PRODUCT, quantity: 1, source: 'home_carousel' })
    expect(toBackendEvents(add)).toMatchObject([{ eventId: add.eventId, eventName: 'add_to_cart', campaignId: CAMPAIGN }])
  })

  it('sends catalog and cart activity as is, without metric events', () => {
    const names = (event) => toBackendEvents(event).map((e) => e.eventName)
    expect(names(frontendEvent('add_to_cart', { productId: PRODUCT, quantity: 1 }))).toEqual(['add_to_cart'])
    expect(names(frontendEvent('product_click', { productId: PRODUCT, source: 'catalog_grid' }))).toEqual(['product_click'])
    expect(names(frontendEvent('home_view', {}, 'home'))).toEqual(['home_view'])

    const update = frontendEvent('cart_quantity_update', { productId: PRODUCT, previousQuantity: 1, quantity: 2 }, 'cart_item')
    expect(toBackendEvents(update)).toEqual([
      {
        eventId: update.eventId,
        eventName: 'cart_quantity_update',
        campaignId: null,
        productId: PRODUCT,
        timestamp: update.timestamp,
        pageName: 'home',
        featureName: 'cart_item',
        properties: { previousQuantity: 1, quantity: 2 },
      },
    ])
  })
})

describe('batching', () => {
  const homeView = () => frontendEvent('home_view', {}, 'home')
  const sizes = (send) => send.mock.calls.map(([events]) => events.length)

  it('posts 20 events per request, the rest two seconds later or when the page is hidden', () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn().mockResolvedValue({})
      const transport = createBackendTransport({ send })
      for (let i = 0; i < 25; i += 1) transport.send(homeView())
      expect(sizes(send)).toEqual([20])
      vi.advanceTimersByTime(1999)
      expect(sizes(send)).toEqual([20])
      vi.advanceTimersByTime(1)
      expect(sizes(send)).toEqual([20, 5])

      transport.send(homeView())
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      expect(sizes(send)).toEqual([20, 5, 1])
    } finally {
      delete document.visibilityState
      vi.useRealTimers()
    }
  })

  it("rejects each queued event's promise when its request fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'))
    const transport = createBackendTransport({ send, batchSize: 2 })
    const results = [transport.send(homeView()), transport.send(homeView())]
    await Promise.all(results.map((result) => expect(result).rejects.toThrow('offline')))
    expect(sizes(send)).toEqual([2])
  })
})

describe('createEventSender', () => {
  const tokens = []
  const request = vi.fn(async (path) => {
    if (path !== '/auth/visitor') return {}
    tokens.push(`visitor-${tokens.length + 1}`)
    return { visitorToken: tokens.at(-1) }
  })
  const authorizations = () =>
    request.mock.calls.filter(([path]) => path === '/analytics/events').map(([, options]) => options.headers?.Authorization)

  it("uses one visitor token per tenant for anonymous visitors, renewed before it expires, and the user's own token when signed in", async () => {
    vi.useFakeTimers()
    try {
      tokens.length = 0
      request.mockClear()
      const send = createEventSender(request)
      await send([{ eventName: 'home_view' }])
      await send([{ eventName: 'home_view' }])
      vi.advanceTimersByTime(VISITOR_TOKEN_RENEW_MS)
      await send([{ eventName: 'home_view' }])
      setRequestTenant('2b6f3e10-0000-4000-8000-000000000002')
      await send([{ eventName: 'home_view' }])
      // Signed in: no visitor token; the HTTP client adds the access token.
      setRequestUser({ userId: 'user_1001', accessToken: 'token-1' })
      await send([{ eventName: 'home_view' }])
      expect(authorizations()).toEqual(['Bearer visitor-1', 'Bearer visitor-1', 'Bearer visitor-2', 'Bearer visitor-3', undefined])
      expect(request.mock.calls.filter(([path]) => path === '/auth/visitor')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks for every visitor token with the same visitor UUID, one per store', async () => {
    vi.useFakeTimers()
    try {
      setRequestUser(null)
      setRequestTenant('2b6f3e10-0000-4000-8000-000000000003')
      request.mockClear()
      const send = createEventSender(request)
      await send([{ eventName: 'home_view' }])
      vi.advanceTimersByTime(VISITOR_TOKEN_RENEW_MS)
      await send([{ eventName: 'home_view' }])
      const sentIds = request.mock.calls.filter(([path]) => path === '/auth/visitor').map(([, options]) => options.body.userId)
      expect(sentIds).toHaveLength(2)
      expect(sentIds[1]).toBe(sentIds[0])
      expect(sentIds[0]).toMatch(/^[0-9a-f-]{36}$/)
      expect(anonymousId('2b6f3e10-0000-4000-8000-000000000004')).not.toBe(sentIds[0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends each batch with the identity its token was issued for', async () => {
    const tenantId = '2b6f3e10-0000-4000-8000-000000000005'
    setRequestTenant(tenantId)
    setRequestUser(null)
    request.mockClear()
    const send = createEventSender(request)
    await send([{ eventName: 'home_view' }])
    setRequestUser({ userId: 'user_1001', accessToken: 'token-1' })
    await send([{ eventName: 'home_view' }])
    setRequestUser(null)
    const bodies = request.mock.calls.filter(([path]) => path === '/analytics/events').map(([, options]) => options.body)
    expect(bodies).toEqual([
      { tenantId, userId: anonymousId(tenantId), userType: 'visitor', events: [{ eventName: 'home_view' }] },
      { tenantId, userId: 'user_1001', userType: 'registered', events: [{ eventName: 'home_view' }] },
    ])
  })

  it('replaces a stored visitor UUID that is not a UUID', () => {
    localStorage.setItem('basketline:anonymous-id:tenant-x', 'tampered')
    expect(anonymousId('tenant-x')).toMatch(/^[0-9a-f-]{36}$/)
    expect(localStorage.getItem('basketline:anonymous-id:tenant-x')).toBe(anonymousId('tenant-x'))
  })

  it('asks for a new visitor token after a failed request', async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ visitorToken: 'visitor-ok' })
    const send = createEventSender(flaky)
    await expect(send([{ eventName: 'home_view' }])).rejects.toThrow('offline')
    await send([{ eventName: 'home_view' }])
    expect(flaky.mock.calls.map(([path]) => path)).toEqual(['/auth/visitor', '/auth/visitor', '/analytics/events'])
  })
})

describe('sending events from the running app', () => {
  it('posts impressions, the ad click with its product, and the add to cart', async () => {
    const send = vi.fn().mockResolvedValue({})
    // One request per event, so each step's events are sent before it is checked.
    setTransport(createTeeTransport([localCollector, createBackendTransport({ send, batchSize: 1 })]))
    const user = userEvent.setup()
    renderApp('/store')

    const sent = () => send.mock.calls.flatMap(([events]) => events)
    // Slide 1 shows three campaigns → three impressions.
    expect(sent().filter((e) => e.eventName === 'impression').map((e) => e.campaignId)).toEqual(['campaign_001', 'campaign_002', 'campaign_003'])

    const carousel = screen.getByRole('region', { name: 'Promotional campaigns' })
    await user.click(within(carousel).getByRole('link', { name: 'Drift Cotton Hoodie' }))
    await screen.findByRole('heading', { level: 1, name: 'Drift Cotton Hoodie' })
    await user.click(screen.getByRole('button', { name: 'Add Drift Cotton Hoodie to cart' }))

    await waitFor(() => expect(sent().filter((e) => e.eventName === 'add_to_cart')).toHaveLength(1))
    expect(sent().filter((e) => e.eventName === 'click')).toMatchObject([{ campaignId: 'campaign_002', productId: 'product_004' }])
    // The backend credits it to that click; the browser sends no link between them.
    expect(sent().filter((e) => e.eventName === 'add_to_cart')).toMatchObject([{ productId: 'product_004', campaignId: null }])
    expect(sent().some((e) => 'attributionId' in e || e.eventName === 'click_to_basket')).toBe(false)
    // Shopping never waits on or fails because of event delivery.
    expect(screen.getByTestId('cart-badge')).toHaveTextContent('1')
  })
})
