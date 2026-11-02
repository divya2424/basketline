import { StrictMode } from 'react'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../app/App.jsx'
import { campaigns } from './campaignData.js'

/** The sample campaigns, standing in for GET /ad/campaigns. */
export const SAMPLE_CATALOG = { campaigns }

/**
 * Renders the whole dashboard under StrictMode, like production, at `route`. By
 * default on the tenant's analytics as its campaign manager: signed out, it
 * redirects to the onboarding page (/), which here opens a dashboard without a
 * full page reload.
 */
export function renderApp(route = '/analytics', { authProps = { persist: false, initialUser: MANAGER }, catalogProps = { initialCatalog: SAMPLE_CATALOG } } = {}) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[route]}>
        <App authProps={authProps} catalogProps={catalogProps} onboardingProps={{ fullReload: false }} />
      </MemoryRouter>
    </StrictMode>,
  )
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
