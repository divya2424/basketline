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
  productIds: ['product_006'],
}
const RESULTS = {
  campaignId: 'c1',
  totals: { impressions: 40, clicks: 4, ctr: 0.1, addToCarts: 1, clickToBasket: 0.25, uniqueCustomers: 30, sessions: 35, convertedSessions: 1 },
  items: [{ productId: 'product_006', name: 'Lumen LED Desk Lamp', impressions: 40, clicks: 4, ctr: 0.1, addToCarts: 1, clickToBasket: 0.25 }],
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

  it("shows a campaign's analytics, its totals and per product, for a chosen period, and pauses it", async () => {
    api = campaignService()
    const user = userEvent.setup()
    renderApp('/seller', { authProps: { persist: false, initialUser: SELLER } })
    const row = await screen.findByTestId('seller-campaign')
    expect(row).toHaveTextContent('Desk deals · Deals · active')
    await user.click(within(row).getByRole('button', { name: 'Analytics' }))
    const table = await within(row).findByRole('table')
    expect(within(row).getByTestId('campaign-totals')).toHaveTextContent(/Impressions\s*40\s*Clicks\s*4\s*CTR\s*10\.0%\s*Add-to-carts\s*1\s*Click-to-basket\s*25\.0%\s*Unique customers\s*30\s*Sessions\s*35\s*Converted sessions\s*1/)
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent(/Lumen LED Desk Lamp\s*40\s*4\s*10\.0%\s*1\s*25\.0%/)
    const days = (url) => (Date.now() - Date.parse(new URL(url).searchParams.get('from'))) / 86_400_000
    expect(Math.round(days(api.requests.filter((r) => r.path.endsWith('/results')).at(-1).url))).toBe(30)
    await user.click(within(row).getByRole('button', { name: '7 days' }))
    await within(row).findByRole('table')
    expect(Math.round(days(api.requests.filter((r) => r.path.endsWith('/results')).at(-1).url))).toBe(7)

    await user.click(within(row).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(api.requests.some((r) => r.method === 'PATCH')).toBe(true))
    expect(api.requests.find((r) => r.method === 'PATCH').body).toEqual({ status: 'paused' })
  })
})
