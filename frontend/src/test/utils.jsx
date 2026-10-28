import { StrictMode } from 'react'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../app/App.jsx'
import { localCollector } from '../analytics/analytics.js'
import { campaigns } from '../features/campaigns/campaignData.js'
import { products } from '../features/products/productData.js'

/** The sample catalog, standing in for GET /products and /campaigns. */
export const SAMPLE_CATALOG = { products, campaigns }

/**
 * Renders the whole app under StrictMode, like production, at `route`. By default
 * inside a tenant's store (/store), signed in as a shopper: signed out, the store
 * redirects to the onboarding page (/), which here opens a store without a
 * full page reload.
 */
export function renderApp(
  route = '/store',
  { cartProps = { persist: false }, authProps = { persist: false, initialUser: SHOPPER }, catalogProps = { initialCatalog: SAMPLE_CATALOG } } = {},
) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[route]}>
        <App cartProps={cartProps} authProps={authProps} catalogProps={catalogProps} onboardingProps={{ fullReload: false }} />
      </MemoryRouter>
    </StrictMode>,
  )
}

export function eventsNamed(eventName) {
  return localCollector.getEvents().filter((event) => event.eventName === eventName)
}

const inHalfAnHour = () => new Date(Date.now() + 30 * 60_000).toISOString()

export const MANAGER = {
  userId: '11111111-1111-4111-8111-111111111111',
  username: 'maya',
  displayName: 'maya',
  role: 'campaign-manager',
  accessToken: 'manager-token',
  expiresAt: inHalfAnHour(),
}
export const SHOPPER = {
  userId: '22222222-2222-4222-8222-222222222222',
  username: 'sam',
  displayName: 'sam',
  role: 'standard-user',
  accessToken: 'shopper-token',
  expiresAt: inHalfAnHour(),
}
