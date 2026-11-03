import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getRequestContext, switchTenant } from '../../api/requestContext.js'
import { SELLERS } from '../products/productData.js'
import { jsonResponse, mockFetch } from '../../test/mockFetch.js'
import { renderApp } from '../../test/utils.jsx'

const FLIPKART = '99999999-9999-4999-8999-999999999999'
const LOGINS = [
  { username: 'seller1', role: 'seller', sellerId: 'seller_northwind' },
  { username: 'seller2', role: 'seller', sellerId: 'seller_contoso' },
  { username: 'user01', role: 'customer' },
  { username: 'user02', role: 'customer' },
]
const SIGNED_OUT = { persist: false, initialUser: null }

let api
afterEach(() => api?.restore())

/** The marketplace's services: its logins, its sellers, and sign-in. */
function marketplace() {
  api = mockFetch(({ path, body }) => {
    if (path === `/stores/${FLIPKART}/logins`) return jsonResponse(200, { items: LOGINS })
    if (path === '/sellers') return jsonResponse(200, { sellers: SELLERS.map(({ id, name }) => ({ sellerId: id, name })) })
    if (path === '/auth/login') {
      const login = LOGINS.find((l) => l.username === body.username)
      return jsonResponse(200, {
        accessToken: `token-${body.username}`,
        user: { id: `id-${body.username}`, username: body.username, role: login.role, ...(login.sellerId ? { sellerId: login.sellerId } : {}) },
        session: { expiresAt: new Date(Date.now() + 1_800_000).toISOString() },
        basketline: null,
      })
    }
    if (path.endsWith('/placements')) return jsonResponse(200, { items: [] })
    if (path.endsWith('/campaigns')) return jsonResponse(200, { items: [], page: { limit: 100, offset: 0, total: 0 } })
    return jsonResponse(404, { error: { code: 'NOT_FOUND' } })
  })
}

describe("a marketplace's page", () => {
  it('lists its sellers by name, to sign in as one with the demo password, landing in the seller portal', async () => {
    switchTenant(FLIPKART, 'Flipkart')
    marketplace()
    const user = userEvent.setup()
    renderApp(`/m/${FLIPKART}`, { authProps: SIGNED_OUT })
    expect(await screen.findByRole('heading', { level: 1, name: 'Flipkart' })).toBeInTheDocument()

    const sell = screen.getByRole('region', { name: 'Sell' })
    expect(within(sell).getAllByRole('button').map((b) => b.textContent)).toEqual(['Northwind Traders', 'Contoso Goods'])
    expect(sell).toHaveTextContent('seller2 · 4 products')

    await user.click(within(sell).getByRole('button', { name: 'Sign in as Contoso Goods' }))
    const form = screen.getByRole('form', { name: 'Sign in as Contoso Goods' })
    expect(within(form).getByLabelText('Username')).toHaveValue('seller2')
    expect(within(form).getByLabelText('Password')).toHaveValue('test')
    await user.click(within(form).getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Seller portal' })).toBeInTheDocument()
    expect(api.requests.find((r) => r.path === '/auth/login').body).toMatchObject({ username: 'seller2', password: 'test' })
    expect(getRequestContext().accessToken).toBe('token-seller2')
  })

  it('lets you shop as a visitor, or sign in as one of its shoppers', async () => {
    switchTenant(FLIPKART, 'Flipkart')
    marketplace()
    const user = userEvent.setup()
    renderApp(`/m/${FLIPKART}`, { authProps: SIGNED_OUT })
    const shop = await screen.findByRole('region', { name: 'Shop' })
    await user.click(within(shop).getByRole('button', { name: 'Sign in as user02' }))
    await user.click(within(screen.getByRole('form', { name: 'Sign in as user02' })).getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'All products' })).toBeInTheDocument())
    expect(getRequestContext().accessToken).toBe('token-user02')
  })

  it('sends you to the marketplaces list when it is not the one you visited', async () => {
    switchTenant(FLIPKART, 'Flipkart')
    marketplace()
    renderApp('/m/11111111-1111-4111-8111-111111111111', { authProps: SIGNED_OUT })
    expect(await screen.findByRole('heading', { level: 1, name: 'Marketplaces' })).toBeInTheDocument()
  })
})
