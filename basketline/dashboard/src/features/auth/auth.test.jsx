import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, MANAGER } from '../../test/utils.jsx'
import { DEFAULT_TENANT_ID, getRequestContext, switchTenant } from '../../api/requestContext.js'
import { jsonResponse, mockFetch } from '../../test/mockFetch.js'

const ACCOUNTS = {
  maya: { password: 'correct horse battery', profile: MANAGER },
}
const TENANT = 'Default storefront'

/** A stand-in for the API gateway: the tenant list, login, logout, and 401 for revoked tokens. */
let requests
function fakeApi({ loginStatus } = {}) {
  const api = mockFetch(({ path, method, headers, body }) => {
    if (headers.get('Authorization') === 'Bearer revoked-token') return jsonResponse(401, { error: { code: 'SESSION_REVOKED', message: 'Session ended' } })
    if (path === '/accounts' && method === 'GET') {
      return jsonResponse(200, { items: [{ tenantId: DEFAULT_TENANT_ID, name: TENANT, tier: 'free', createdAt: '2026-10-01T00:00:00.000Z' }] })
    }
    if (path.endsWith('/auth/login')) {
      if (loginStatus === 429) return jsonResponse(429, { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' } })
      const account = ACCOUNTS[body.username.toLowerCase()]
      if (!account || account.password !== body.password) {
        return jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } })
      }
      const { profile } = account
      return jsonResponse(200, {
        accessToken: profile.accessToken,
        tokenType: 'Bearer',
        expiresIn: 1800,
        user: { id: profile.userId, username: profile.username, role: profile.role },
        session: { id: 'session-1', clientType: 'web', expiresAt: profile.expiresAt, sessionEndTime: null },
      })
    }
    if (path.endsWith('/auth/logout')) return jsonResponse(200, { session: { sessionEndTime: new Date().toISOString() } })
    if (path.includes('/ad/')) return jsonResponse(200, { count: 1 })
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
  })
  requests = api.requests
  return api
}

let fetchApi
beforeEach(() => {
  fetchApi = fakeApi()
})
afterEach(() => {
  fetchApi.restore()
  switchTenant(DEFAULT_TENANT_ID)
  localStorage.clear()
  sessionStorage.clear()
})

const SIGNED_OUT = { authProps: { persist: false, initialUser: null } }
const analyticsLink = () => screen.queryByRole('link', { name: 'Analytics' })
const loginRequest = () => requests.find((r) => r.path === '/auth/login')
const onboardingHeading = () => screen.findByRole('heading', { name: 'Tenants' })

/** On the onboarding page: the tenant row's Log in opens the tenant's sign-in dialog. */
async function openSignIn(user) {
  await user.click(await screen.findByRole('button', { name: `Log in: ${TENANT}` }))
  return screen.getByRole('dialog', { name: `Sign in to ${TENANT}` })
}

async function signIn(user, username, password) {
  const dialog = await openSignIn(user)
  await user.type(within(dialog).getByLabelText('Username'), username)
  await user.type(within(dialog).getByLabelText('Password'), password)
  await user.click(within(dialog).getByRole('button', { name: 'Sign in' }))
  return dialog
}

describe('login modal', () => {
  it('has only username and password fields', async () => {
    const user = userEvent.setup()
    renderApp('/', SIGNED_OUT)
    const dialog = await openSignIn(user)
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1)
    expect(within(dialog).getByLabelText('Username')).toHaveFocus()
    expect(within(dialog).getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(dialog.querySelectorAll('input')).toHaveLength(2)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('validates empty fields and shows the API’s rejection without saying which field was wrong', async () => {
    const user = userEvent.setup()
    renderApp('/', SIGNED_OUT)
    const dialog = await openSignIn(user)
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter your username and password.')
    expect(loginRequest()).toBeUndefined()

    await user.type(within(dialog).getByLabelText('Username'), 'maya')
    await user.type(within(dialog).getByLabelText('Password'), 'wrong password!')
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Invalid username or password.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Password')).toHaveValue('')
    expect(analyticsLink()).not.toBeInTheDocument()
  })

  it('explains rate limiting and unreachable servers', async () => {
    fetchApi.restore()
    fetchApi = fakeApi({ loginStatus: 429 })
    const user = userEvent.setup()
    renderApp('/', SIGNED_OUT)
    await signIn(user, 'maya', 'correct horse battery')
    expect(await screen.findByText(/Too many sign-in attempts/)).toBeInTheDocument()

    fetchApi.restore()
    fetchApi = mockFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    await user.type(screen.getByLabelText('Password'), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/Can’t reach the server/)).toBeInTheDocument()
  })

  it('sends a web login for the chosen tenant and shows a loader while it is pending', async () => {
    const user = userEvent.setup()
    renderApp('/', SIGNED_OUT)
    const dialog = await signIn(user, 'maya', 'correct horse battery')
    const submit = within(dialog).getByRole('button', { name: 'Signing in…' })
    expect(submit).toBeDisabled()
    expect(submit.querySelector('.spinner')).not.toBeNull()
    expect(await screen.findByRole('button', { name: 'Logout' })).toBeInTheDocument()
    expect(loginRequest()).toMatchObject({
      method: 'POST',
      body: { username: 'maya', password: 'correct horse battery', clientType: 'web' },
    })
    expect(loginRequest().headers.get('tenant_id')).toBe(DEFAULT_TENANT_ID)
  })
})

describe('header', () => {
  it('shows only the platform brand on the onboarding page', async () => {
    renderApp('/', SIGNED_OUT)
    await onboardingHeading()
    const header = screen.getByRole('banner')
    expect(within(header).getByRole('link', { name: 'Basketline: onboarding' })).toHaveTextContent('Basketline')
    expect(within(header).queryByRole('button', { name: 'Logout' })).not.toBeInTheDocument()
  })

  it("inside a tenant shows the tenant's name, Analytics, the user and Logout", async () => {
    const user = userEvent.setup()
    renderApp('/', SIGNED_OUT)
    await signIn(user, 'maya', 'correct horse battery')
    const header = await screen.findByRole('banner')
    expect(await within(header).findByRole('link', { name: `${TENANT} analytics` })).toHaveTextContent(TENANT)
    expect(within(header).getByRole('link', { name: 'Analytics' })).toBeInTheDocument()
    expect(within(header).getByText(MANAGER.displayName)).toBeInTheDocument()
    expect(within(header).queryByRole('link', { name: /^Cart,/ })).not.toBeInTheDocument()
  })
})

describe('session handling', () => {
  it('sends the token with later requests, and logout ends the session and returns to onboarding', async () => {
    const user = userEvent.setup()
    renderApp('/', SIGNED_OUT)
    await signIn(user, 'maya', 'correct horse battery')
    await screen.findByRole('heading', { name: 'Campaign Analytics' })
    await vi.waitFor(() => expect(requests.some((r) => r.path.includes('/ad/'))).toBe(true))
    expect(requests.filter((r) => r.path.includes('/ad/')).every((r) => r.headers.get('Authorization') === 'Bearer manager-token')).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Logout' }))
    await onboardingHeading()
    const logout = requests.find((r) => r.path === '/auth/logout')
    expect(logout.headers.get('Authorization')).toBe('Bearer manager-token')
    expect(analyticsLink()).not.toBeInTheDocument()
  })

  it('returns to onboarding when the API rejects the token (expired or revoked)', async () => {
    renderApp('/analytics', { authProps: { persist: false, initialUser: { ...MANAGER, accessToken: 'revoked-token' } } })
    expect(await onboardingHeading()).toBeInTheDocument()
    expect(getRequestContext().accessToken).toBeNull()
  })

  it('does not restore an expired session', async () => {
    sessionStorage.setItem('basketline:session:v3', JSON.stringify({ ...MANAGER, tenantId: DEFAULT_TENANT_ID, expiresAt: new Date(Date.now() - 1000).toISOString() }))
    renderApp('/analytics', { authProps: {} })
    expect(await onboardingHeading()).toBeInTheDocument()
  })

  it("doesn't restore a session that belongs to another tenant", async () => {
    sessionStorage.setItem('basketline:session:v3', JSON.stringify({ ...MANAGER, tenantId: '33333333-3333-4333-8333-333333333333' }))
    renderApp('/analytics', { authProps: {} })
    expect(await onboardingHeading()).toBeInTheDocument()
  })

  it('restores the session from sessionStorage, without the password', async () => {
    const user = userEvent.setup()
    const { unmount } = renderApp('/', { authProps: {} })
    await signIn(user, 'maya', 'correct horse battery')
    await screen.findByRole('button', { name: 'Logout' })
    expect(sessionStorage.getItem('basketline:session:v3')).not.toMatch(/correct horse battery/)
    unmount()
    renderApp('/analytics', { authProps: {} })
    expect(analyticsLink()).toBeInTheDocument()
  })
})

describe('role-based access to analytics', () => {
  it('shows Analytics to a campaign manager after signing in, and hides it again on logout', async () => {
    const user = userEvent.setup()
    renderApp('/', SIGNED_OUT)
    expect(analyticsLink()).not.toBeInTheDocument()

    await signIn(user, 'Maya ', 'correct horse battery')
    expect(await screen.findByRole('heading', { name: 'Campaign Analytics' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(analyticsLink()).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Logout' }))
    await onboardingHeading()
    expect(analyticsLink()).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Campaign Analytics' })).not.toBeInTheDocument()
  })

  it('sends a signed-out visitor of the dashboard to onboarding', async () => {
    renderApp('/analytics', SIGNED_OUT)
    expect(await onboardingHeading()).toBeInTheDocument()
  })
})
