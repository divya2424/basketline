import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createEvent, localCollector, setTransport } from './analytics.js'
import { createBackendTransport, toBackendEvents } from './backendTransport.js'
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

/** A stand-in for the Basketline SDK that records what the storefront hands it (the SDK repo has its own tests). */
function recordingSdk() {
  const clients = []
  const createClient = ({ tenantId }) => {
    const client = { tenantId, tracked: [], identities: [] }
    client.sendEvent = (eventName, fields) => client.tracked.push({ eventName, ...fields })
    client.identify = ({ userId, getToken }) => client.identities.push({ userId, token: getToken() })
    client.reset = () => client.identities.push('reset')
    client.flush = async () => {}
    clients.push(client)
    return client
  }
  return { clients, createClient }
}

describe('createBackendTransport', () => {
  it('sends through one SDK client per store, following sign-in and sign-out', () => {
    const { clients, createClient } = recordingSdk()
    const transport = createBackendTransport({ apiUrl: 'http://api.test', createClient })
    const homeView = () => frontendEvent('home_view', {}, 'home')
    setRequestTenant('2b6f3e10-0000-4000-8000-000000000011')
    setRequestUser(null)
    transport.send(homeView())
    setRequestUser({ userId: 'user_1001', accessToken: 'token-1' })
    transport.send(homeView())
    transport.send(homeView())
    setRequestUser(null)
    transport.send(homeView())
    setRequestTenant('2b6f3e10-0000-4000-8000-000000000012')
    transport.send(homeView())

    expect(clients.map((c) => c.tenantId)).toEqual(['2b6f3e10-0000-4000-8000-000000000011', '2b6f3e10-0000-4000-8000-000000000012'])
    // Identified once with the user's own access token, reset on sign-out.
    expect(clients[0].identities).toEqual([{ userId: 'user_1001', token: 'token-1' }, 'reset'])
    expect(clients[0].tracked).toHaveLength(4)
    expect(clients[1].tracked).toHaveLength(1)
  })
})

describe('sending events from the running app', () => {
  it('sends impressions, the ad click with its product, and the add to cart', async () => {
    const { clients, createClient } = recordingSdk()
    setRequestUser(null)
    setTransport(createTeeTransport([localCollector, createBackendTransport({ apiUrl: 'http://api.test', createClient })]))
    const user = userEvent.setup()
    renderApp('/store')

    const sent = () => clients.flatMap((c) => c.tracked)
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
