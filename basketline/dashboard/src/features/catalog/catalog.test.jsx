import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AuthProvider } from '../auth/AuthContext.jsx'
import { CatalogProvider, useCatalog } from './CatalogContext.jsx'
import { jsonResponse, mockFetch } from '../../test/mockFetch.js'
import { MANAGER } from '../../test/utils.jsx'

const CAMPAIGNS = [{ id: 'cccccccc-0000-4000-8000-000000000001', title: 'Festive Gifting', sellerId: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'active' }]

function Titles() {
  const { status, campaigns } = useCatalog()
  return <p data-testid="campaigns">{status === 'ready' ? campaigns.map((campaign) => campaign.title).join(', ') || 'none' : status}</p>
}

const renderCatalog = (initialUser) =>
  render(
    <AuthProvider persist={false} initialUser={initialUser}>
      <CatalogProvider>
        <Titles />
      </CatalogProvider>
    </AuthProvider>,
  )

let api
afterEach(() => api.restore())

describe('campaign catalog', () => {
  it("loads the signed-in tenant's campaigns from GET /ad/campaigns", async () => {
    api = mockFetch(() => jsonResponse(200, { items: CAMPAIGNS }))
    renderCatalog(MANAGER)
    expect(await screen.findByText('Festive Gifting')).toBeInTheDocument()
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0].path).toBe('/ad/campaigns')
    expect(api.requests[0].headers.get('authorization')).toBe(`Bearer ${MANAGER.accessToken}`)
  })

  it('asks for nothing when signed out', async () => {
    api = mockFetch(() => jsonResponse(200, { items: CAMPAIGNS }))
    renderCatalog(null)
    expect(await screen.findByText('none')).toBeInTheDocument()
    expect(api.requests).toHaveLength(0)
  })
})
