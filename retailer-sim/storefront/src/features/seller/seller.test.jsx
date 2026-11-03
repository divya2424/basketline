import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { placements } from '../campaigns/campaignData.js'
import { jsonResponse, mockFetch } from '../../test/mockFetch.js'
import { renderApp, SHOPPER } from '../../test/utils.jsx'

const SELLER = { ...SHOPPER, username: 'seller1', displayName: 'seller1', role: 'seller', sellerId: 'seller_contoso', shopper: null }
const CAMPAIGN = {
  id: 'c1',
  title: 'Desk deals',
  placement: 'deals',
  status: 'active',
  sellerId: 'seller_contoso',
  productIds: ['product_006', 'product_010'],
}
const RESULTS = {
  campaignId: 'c1',
  totals: { impressions: 40, clicks: 4, ctr: 0.1, addToCarts: 1, clickToBasket: 0.25, uniqueCustomers: 30, sessions: 35, convertedSessions: 1 },
  byClient: {
    web: { impressions: 30, clicks: 3, addToCarts: 1, customers: 22, sessions: 26 },
    mobile: { impressions: 10, clicks: 1, addToCarts: 0, customers: 10, sessions: 9 },
  },
  bothClients: 2,
  byUserType: {
    visitor: { customers: 24, viewed: 24, clicked: 2, addedToCart: 0 },
    registered: { customers: 8, viewed: 6, clicked: 2, addedToCart: 1 },
  },
  bothUserTypes: 2,
  items: [
    { productId: 'product_006', name: 'Lumen LED Desk Lamp', category: 'Home', impressions: 40, clicks: 4, ctr: 0.1, addToCarts: 1, clickToBasket: 0.25 },
    { productId: 'product_010', name: 'Glide Ergonomic Wireless Mouse', category: 'Accessories', impressions: 0, clicks: 0, ctr: 0, addToCarts: 0, clickToBasket: 0 },
  ],
}

let api
afterEach(() => api?.restore())

/** The campaign service, as the seller portal calls it. */
function campaignService() {
  return mockFetch(({ path, method }) => {
    if (path.endsWith('/placements')) return jsonResponse(200, { items: placements })
    if (path.endsWith('/campaigns') && method === 'GET') return jsonResponse(200, { items: [CAMPAIGN], page: { limit: 100, offset: 0, total: 1 } })
    if (path.endsWith('/campaigns') && method === 'POST') return jsonResponse(201, { ...CAMPAIGN, id: 'c2' })
    if (path.endsWith('/c1/results')) return jsonResponse(200, RESULTS)
    if (path.endsWith('/c1') && method === 'GET') return jsonResponse(200, CAMPAIGN)
    if (path.endsWith('/c1') && method === 'PATCH') return jsonResponse(200, { ...CAMPAIGN, status: 'paused' })
    return jsonResponse(404, { error: { code: 'NOT_FOUND' } })
  })
}

describe('the seller portal', () => {
  it('is only for sellers', () => {
    renderApp('/seller')
    return expect(screen.findByText('Sign in as a seller to run campaigns for your products.')).resolves.toBeInTheDocument()
  })

  it("lists the seller's own campaigns and creates one in a section, with only its own products to choose from", async () => {
    api = campaignService()
    const user = userEvent.setup()
    renderApp('/seller', { authProps: { persist: false, initialUser: SELLER } })
    expect(await screen.findByText('Desk deals')).toBeInTheDocument()
    expect(api.requests.find((r) => r.path.endsWith('/campaigns')).url).toContain('sellerId=seller_contoso')

    const form = screen.getByRole('form', { name: 'Create a campaign' })
    // Contoso's products only.
    expect(within(form).getAllByRole('checkbox').map((box) => box.parentElement.textContent)).toEqual([
      'Summit 30L Travel Backpack',
      'Lumen LED Desk Lamp',
      'Verde Insulated Steel Bottle',
      'Glide Ergonomic Wireless Mouse',
    ])
    await user.type(within(form).getByLabelText('Campaign title'), 'Spotlight lamps')
    await user.selectOptions(within(form).getByLabelText('Campaign type'), 'spotlight')
    await user.click(within(form).getByLabelText('Lumen LED Desk Lamp'))
    await user.click(within(form).getByRole('button', { name: 'Create campaign' }))
    await waitFor(() => expect(api.requests.some((r) => r.method === 'POST')).toBe(true))
    expect(api.requests.find((r) => r.method === 'POST').body).toEqual({ title: 'Spotlight lamps', placement: 'spotlight', status: 'active', productIds: ['product_006'] })
  })

  it("shows each campaign as a card, linking to its analytics", async () => {
    api = campaignService()
    renderApp('/seller', { authProps: { persist: false, initialUser: SELLER } })
    const card = await screen.findByTestId('seller-campaign')
    expect(card).toHaveTextContent(/Desk deals\s*Deals\s*active\s*2 products/)
    expect(within(card).getByRole('link', { name: 'View analytics' })).toHaveAttribute('href', '/seller/campaigns/c1')
  })
})

describe("a campaign's analytics page", () => {
  const days = (url) => Math.round((Date.now() - Date.parse(new URL(url).searchParams.get('from'))) / 86_400_000)
  const lastResults = () => api.requests.filter((r) => r.path.endsWith('/results')).at(-1).url

  it('shows the headline numbers, the funnel, web vs mobile and every product', async () => {
    api = campaignService()
    renderApp('/seller/campaigns/c1', { authProps: { persist: false, initialUser: SELLER } })
    expect(await screen.findByRole('heading', { level: 1, name: 'Desk deals' })).toBeInTheDocument()
    const kpis = await screen.findByTestId('campaign-totals')
    expect(kpis).toHaveTextContent(/Impressions\s*40.*Clicks\s*4\s*10\.0% click-through rate.*Add-to-carts\s*1\s*25\.0% of clicks.*Unique customers\s*30.*Sessions\s*35\s*1 converted/)

    const funnel = screen.getByRole('region', { name: 'Funnel' })
    expect(funnel).toHaveTextContent('10.0% of impressions clicked')
    expect(funnel).toHaveTextContent('25.0% of clicks added to cart')

    const devices = screen.getByTestId('by-client')
    expect(within(devices).getByRole('img', { name: 'Impressions: web 30 (75.0%), mobile 10 (25.0%)' })).toBeInTheDocument()
    expect(devices).toHaveTextContent('2 used both apps')
    const users = screen.getByTestId('by-user-type')
    expect(within(users).getByRole('img', { name: 'Customers: visitors 24 (75.0%), registered 8 (25.0%)' })).toBeInTheDocument()
    expect(within(users).getByRole('img', { name: 'Added to cart: visitors 0 (0.0%), registered 1 (100.0%)' })).toBeInTheDocument()
    expect(users).toHaveTextContent('2 signed in during their visit')

    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent(/1\s*Lumen LED Desk Lamp\s*Home\s*40\s*4\s*10\.0%\s*1\s*25\.0%/)
    expect(rows[1]).toHaveClass('product-table__idle')
    expect(screen.getByText('1 of 2 products had no activity in this period.')).toBeInTheDocument()
  })

  it('switches the period, and pauses the campaign', async () => {
    api = campaignService()
    const user = userEvent.setup()
    renderApp('/seller/campaigns/c1', { authProps: { persist: false, initialUser: SELLER } })
    await screen.findByTestId('campaign-totals')
    expect(days(lastResults())).toBe(30)
    await user.click(screen.getByRole('button', { name: '7 days' }))
    await screen.findByTestId('campaign-totals')
    expect(days(lastResults())).toBe(7)

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(api.requests.some((r) => r.method === 'PATCH')).toBe(true))
    expect(api.requests.find((r) => r.method === 'PATCH').body).toEqual({ status: 'paused' })
  })
})
