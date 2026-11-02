import { StrictMode } from 'react'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../app/App.jsx'
import { localCollector } from '../analytics/analytics.js'
import { campaigns } from '../features/campaigns/campaignData.js'
import { products } from '../features/products/productData.js'

/** The sample catalog, standing in for GET /products and /campaigns. */
export const SAMPLE_CATALOG = { products, campaigns }

/** Renders the whole store under StrictMode, like production, at `route`; by default signed in as a shopper. */
export function renderApp(
  route = '/store',
  { cartProps = { persist: false }, authProps = { persist: false, initialUser: SHOPPER }, catalogProps = { initialCatalog: SAMPLE_CATALOG } } = {},
) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[route]}>
        <App cartProps={cartProps} authProps={authProps} catalogProps={catalogProps} />
      </MemoryRouter>
    </StrictMode>,
  )
}

export function eventsNamed(eventName) {
  return localCollector.getEvents().filter((event) => event.eventName === eventName)
}

const inHalfAnHour = () => new Date(Date.now() + 30 * 60_000).toISOString()

export const SHOPPER = {
  userId: '22222222-2222-4222-8222-222222222222',
  username: 'sam',
  displayName: 'sam',
  role: 'standard-user',
  accessToken: 'shopper-token',
  expiresAt: inHalfAnHour(),
}
