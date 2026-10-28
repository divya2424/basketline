import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, SAMPLE_CATALOG } from '../../test/utils.jsx'
import { jsonResponse, mockFetch } from '../../test/mockFetch.js'
const page = (items) => ({ items, page: { limit: 100, offset: 0, total: items.length } })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('catalog from the API', () => {
  it('loads products and active campaigns, showing a loader meanwhile', async () => {
    const { requests } = mockFetch(({ path }) =>
      path.endsWith('/products') ? jsonResponse(200, page(SAMPLE_CATALOG.products)) : jsonResponse(200, page(SAMPLE_CATALOG.campaigns)),
    )
    renderApp('/store', { catalogProps: {} })
    expect(screen.getByText('Loading products…')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'All products' })).toBeInTheDocument()
    expect(screen.getByText('10 items')).toBeInTheDocument()
    expect(requests.map((request) => request.url).sort()).toEqual([
      'http://api.test/campaigns?status=active&limit=100',
      'http://api.test/products?limit=100',
    ])
  })

  it('shows an error with a retry when the API is unreachable', async () => {
    let online = false
    mockFetch(({ path }) => {
      if (!online) throw new TypeError('Failed to fetch')
      return path.endsWith('/products') ? jsonResponse(200, page(SAMPLE_CATALOG.products)) : jsonResponse(200, page([]))
    })
    const user = userEvent.setup()
    renderApp('/store', { catalogProps: {} })
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t load the store right now.')

    online = true
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'All products' })).toBeInTheDocument()
  })
})
