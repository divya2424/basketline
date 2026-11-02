import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../../test/utils.jsx'
import { getRequestContext } from '../../api/requestContext.js'
import { jsonResponse, mockFetch } from '../../test/mockFetch.js'

const ACME = { tenantId: '77777777-7777-4777-8777-777777777777', name: 'Acme', tier: 'pro', createdAt: '2026-11-01T10:00:00.000Z' }
const NEW_STORE = { tenantId: '88888888-8888-4888-8888-888888888888', name: 'Corner Shop', tier: 'free', createdAt: '2026-11-03T10:00:00.000Z' }
const CONNECTED = {
  store: NEW_STORE,
  users: [{ username: 'staff' }, { username: 'user01' }],
  password: 'test',
  basketlineUsers: [{ username: 'admin@corner-shop' }, { username: 'seller01' }],
  basketlinePassword: 'basketline-password',
  seed: { products: 12, campaigns: 2 },
}

/** A stand-in for the store's auth service: the list of stores, and connecting one. */
let api
function fakeStores({ listStatus = 200 } = {}) {
  const stores = [ACME]
  api = mockFetch(({ path, method, body }) => {
    if (path === '/stores' && method === 'GET') {
      return listStatus === 200 ? jsonResponse(200, { items: stores }) : jsonResponse(listStatus, { error: { code: 'INTERNAL', message: 'Stores are down' } })
    }
    if (path === '/stores' && method === 'POST') {
      if (body.name === 'Taken') return jsonResponse(503, { error: { code: 'BASKETLINE_UNAVAILABLE', message: 'Basketline is unavailable' } })
      stores.unshift(NEW_STORE)
      return jsonResponse(201, CONNECTED)
    }
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
  })
}
afterEach(() => api?.restore())

const SIGNED_OUT = { persist: false, initialUser: null }

describe('stores page', () => {
  it('lists the connected stores and opens one in the store', async () => {
    fakeStores()
    const navigateTo = vi.fn()
    const user = userEvent.setup()
    renderApp('/stores', { authProps: SIGNED_OUT, storesProps: { navigateTo } })
    const [row] = await screen.findAllByTestId('store-row')
    expect(row).toHaveTextContent('Acme · Pro')
    expect(row).toHaveTextContent(ACME.tenantId)

    await user.click(within(row).getByRole('button', { name: 'Open Acme' }))
    expect(navigateTo).toHaveBeenCalledWith('/store')
    expect(getRequestContext()).toMatchObject({ tenantId: ACME.tenantId, tenantName: 'Acme' })
  })

  it('connects a store and shows its logins and seed', async () => {
    fakeStores()
    const navigateTo = vi.fn()
    const user = userEvent.setup()
    renderApp('/stores', { authProps: SIGNED_OUT, storesProps: { navigateTo } })
    await screen.findAllByTestId('store-row')

    await user.click(screen.getByRole('button', { name: 'Connect to Basketline' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the store’s name.')

    await user.type(screen.getByLabelText('Store name'), 'Corner Shop')
    await user.click(screen.getByRole('button', { name: 'Connect to Basketline' }))
    const connected = await screen.findByRole('status', { name: 'Corner Shop is connected' })
    expect(within(connected).getByTestId('connected-tenant-id')).toHaveTextContent(NEW_STORE.tenantId)
    expect(connected).toHaveTextContent('staff, user01')
    expect(connected).toHaveTextContent('admin@corner-shop, seller01')
    expect(connected).toHaveTextContent('Seeding 12 products and 2 active campaigns')
    expect(api.requests.find((r) => r.method === 'POST')).toMatchObject({ body: { name: 'Corner Shop', tier: 'free' } })
    expect(await screen.findAllByTestId('store-row')).toHaveLength(2)

    await user.click(within(connected).getByRole('button', { name: 'Open Corner Shop' }))
    expect(navigateTo).toHaveBeenCalledWith('/store')
    expect(getRequestContext().tenantId).toBe(NEW_STORE.tenantId)
  })

  it('shows why connecting or listing failed', async () => {
    fakeStores({ listStatus: 500 })
    const user = userEvent.setup()
    renderApp('/stores', { authProps: SIGNED_OUT })
    expect(await screen.findByText(/Couldn’t load the stores: Stores are down/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('Store name'), 'Taken')
    await user.click(screen.getByRole('button', { name: 'Connect to Basketline' }))
    expect(await screen.findByText('Basketline is unavailable')).toBeInTheDocument()
  })
})
