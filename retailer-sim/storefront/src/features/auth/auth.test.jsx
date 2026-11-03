import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, eventsNamed, SHOPPER } from '../../test/utils.jsx'
import { localCollector } from '../../analytics/analytics.js'
import { DEFAULT_TENANT_ID, getRequestContext, switchTenant } from '../../api/requestContext.js'
import { apiRequest } from '../../api/httpClient.js'
import { jsonResponse, mockFetch } from '../../test/mockFetch.js'

const STAFF = { ...SHOPPER, userId: '55555555-5555-4555-8555-555555555555', username: 'staff', displayName: 'staff', role: 'staff', accessToken: 'staff-token', shopper: null }
const ACCOUNTS = {
  sam: { password: 'another long password', profile: SHOPPER },
  staff: { password: 'another long password', profile: STAFF },
}
const VISITOR_ID = '66666666-6666-4666-8666-666666666666'
const STORE = 'Default storefront'

/** A stand-in for the store's auth service: login (a customer also gets a Basketline shopper token), and 401 for revoked tokens. */
let requests
function fakeApi({ loginStatus, shopperToken = true } = {}) {
  const api = mockFetch(({ path, headers, body }) => {
    if (headers.get('Authorization') === 'Bearer revoked-token') return jsonResponse(401, { error: { code: 'SESSION_REVOKED', message: 'Session ended' } })
    if (path.endsWith('/auth/login')) {
      if (loginStatus === 429) return jsonResponse(429, { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' } })
      if (loginStatus === 404) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Store not found' } })
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
        session: { expiresAt: profile.expiresAt },
        basketline: profile.shopper && shopperToken ? { userId: profile.shopper.userId, shopperToken: profile.shopper.token, expiresIn: 1800 } : null,
      })
    }
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
  })
  requests = api.requests
  return api
}

let fetchApi
beforeEach(() => {
  fetchApi = fakeApi()
  switchTenant(DEFAULT_TENANT_ID, STORE)
})
afterEach(() => {
  fetchApi.restore()
  switchTenant(DEFAULT_TENANT_ID)
  localStorage.clear()
  sessionStorage.clear()
})

const SIGNED_OUT = { authProps: { persist: false, initialUser: null } }
const loginRequest = () => requests.find((r) => r.path === '/auth/login')
const loginButton = () => screen.queryByRole('button', { name: 'Log in' })

/** The header's Log in opens the store's sign-in dialog. */
async function openSignIn(user) {
  await user.click(await screen.findByRole('button', { name: 'Log in' }))
  return screen.getByRole('dialog', { name: `Sign in to ${STORE}` })
}

async function signIn(user, username, password) {
  const dialog = await openSignIn(user)
  await user.type(within(dialog).getByLabelText('Username'), username)
  await user.type(within(dialog).getByLabelText('Password'), password)
  await user.click(within(dialog).getByRole('button', { name: 'Sign in' }))
  return dialog
}

describe('login modal', () => {
  it('has only username and password fields, and tracks login_click', async () => {
    const user = userEvent.setup()
    renderApp('/store', SIGNED_OUT)
    const dialog = await openSignIn(user)
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1)
    expect(within(dialog).getByLabelText('Username')).toHaveFocus()
    expect(within(dialog).getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(dialog.querySelectorAll('input')).toHaveLength(2)
    expect(eventsNamed('login_click')).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('validates empty fields and shows the API’s rejection without saying which field was wrong', async () => {
    const user = userEvent.setup()
    renderApp('/store', SIGNED_OUT)
    const dialog = await openSignIn(user)
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter your username and password.')
    expect(loginRequest()).toBeUndefined()

    await user.type(within(dialog).getByLabelText('Username'), 'sam')
    await user.type(within(dialog).getByLabelText('Password'), 'wrong password!')
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Invalid username or password.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Password')).toHaveValue('')
  })

  it('explains a store that isn’t set up yet', async () => {
    fetchApi.restore()
    fetchApi = fakeApi({ loginStatus: 404 })
    const user = userEvent.setup()
    renderApp('/store', SIGNED_OUT)
    await signIn(user, 'sam', 'another long password')
    expect(await screen.findByText('This store isn’t set up yet.')).toBeInTheDocument()
  })

  it('explains rate limiting and unreachable servers', async () => {
    fetchApi.restore()
    fetchApi = fakeApi({ loginStatus: 429 })
    const user = userEvent.setup()
    renderApp('/store', SIGNED_OUT)
    await signIn(user, 'sam', 'another long password')
    expect(await screen.findByText(/Too many sign-in attempts/)).toBeInTheDocument()

    fetchApi.restore()
    fetchApi = mockFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    await user.type(screen.getByLabelText('Password'), 'another long password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/Can’t reach the server/)).toBeInTheDocument()
  })

  it('sends a web login for the store’s tenant, with the SDK’s visitor, and shows a loader while it is pending', async () => {
    localStorage.setItem(`basketline:anonymous-id:${DEFAULT_TENANT_ID}`, VISITOR_ID)
    const user = userEvent.setup()
    renderApp('/store', SIGNED_OUT)
    const dialog = await signIn(user, 'sam', 'another long password')
    const submit = within(dialog).getByRole('button', { name: 'Signing in…' })
    expect(submit).toBeDisabled()
    expect(submit.querySelector('.spinner')).not.toBeNull()
    expect(await screen.findByRole('button', { name: 'Logout' })).toBeInTheDocument()
    expect(loginRequest()).toMatchObject({
      method: 'POST',
      body: { username: 'sam', password: 'another long password', clientType: 'web', visitorId: VISITOR_ID },
    })
    expect(loginRequest().headers.get('tenant_id')).toBe(DEFAULT_TENANT_ID)
  })

  it('never puts credentials into analytics events', async () => {
    const user = userEvent.setup()
    renderApp('/store', SIGNED_OUT)
    await signIn(user, 'sam', 'another long password')
    await screen.findByRole('button', { name: 'Logout' })
    expect(JSON.stringify(localCollector.getEvents())).not.toMatch(/another long password/)
  })
})

describe('header', () => {
  it("shows a visitor the store's name, Log in and the cart", async () => {
    renderApp('/store', SIGNED_OUT)
    const header = screen.getByRole('banner')
    expect(within(header).getByRole('link', { name: `${STORE} home` })).toHaveTextContent(STORE)
    expect(within(header).getByRole('button', { name: 'Log in' })).toBeInTheDocument()
    expect(within(header).getByRole('link', { name: /^Cart,/ })).toBeInTheDocument()
  })

  it('shows a signed-in shopper their name and Logout instead of Log in', async () => {
    const user = userEvent.setup()
    renderApp('/store', SIGNED_OUT)
    await signIn(user, 'sam', 'another long password')
    const header = screen.getByRole('banner')
    expect(await within(header).findByText(SHOPPER.displayName)).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Logout' })).toBeInTheDocument()
    expect(within(header).queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument()
  })
})

describe('session handling', () => {
  it('keeps a customer’s Basketline shopper token for the SDK; staff and a Basketline outage get none', async () => {
    const user = userEvent.setup()
    // Logout leaves the store: each sign-in starts in it again.
    const signInFresh = async (username) => {
      switchTenant(DEFAULT_TENANT_ID, STORE)
      const view = renderApp('/store', SIGNED_OUT)
      await signIn(user, username, 'another long password')
      await screen.findByRole('button', { name: 'Logout' })
      return view
    }
    let view = await signInFresh('sam')
    expect(getRequestContext().shopper).toMatchObject({ userId: SHOPPER.shopper.userId, token: SHOPPER.shopper.token })
    view.unmount()

    view = await signInFresh('staff')
    expect(getRequestContext()).toMatchObject({ userId: STAFF.userId, shopper: null })
    view.unmount()

    fetchApi.restore()
    fetchApi = fakeApi({ shopperToken: false })
    await signInFresh('sam')
    await screen.findByRole('button', { name: 'Logout' })
    expect(getRequestContext()).toMatchObject({ userId: SHOPPER.userId, shopper: null })
  })

  it('logout forgets the session without a request and leaves the marketplace for the Marketplaces page', async () => {
    const user = userEvent.setup()
    renderApp('/store', { authProps: {} })
    await signIn(user, 'sam', 'another long password')
    await user.click(await screen.findByRole('button', { name: 'Logout' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Marketplaces' })).toBeInTheDocument()
    expect(requests.map((r) => r.path).filter((path) => path.startsWith('/auth'))).toEqual(['/auth/login'])
    expect(getRequestContext()).toMatchObject({ userId: null, accessToken: null, shopper: null, tenantName: null })
    expect(localStorage.getItem('basketline:tenant')).toBeNull()
    expect(sessionStorage.getItem('retailer:session:v1')).toBeNull()
    // The app's own header: no marketplace nav, sign-in or cart.
    const header = screen.getByRole('banner')
    expect(within(header).queryByRole('link', { name: 'Shop' })).not.toBeInTheDocument()
    expect(within(header).queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument()
    expect(within(header).queryByTestId('cart-badge')).not.toBeInTheDocument()
  })

  it('signs out when the API rejects the token (expired or revoked)', async () => {
    renderApp('/store', { authProps: { persist: false, initialUser: { ...SHOPPER, accessToken: 'revoked-token' } } })
    // Any authenticated request to the store's services answers 401.
    await apiRequest('/products').catch(() => {})
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument()
    expect(getRequestContext().accessToken).toBeNull()
  })

  it('does not restore an expired session', () => {
    sessionStorage.setItem('retailer:session:v1', JSON.stringify({ ...SHOPPER, tenantId: DEFAULT_TENANT_ID, expiresAt: new Date(Date.now() - 1000).toISOString() }))
    renderApp('/store', { authProps: {} })
    expect(loginButton()).toBeInTheDocument()
  })

  it('restores the session from sessionStorage, without the password', async () => {
    const user = userEvent.setup()
    const { unmount } = renderApp('/store', { authProps: {} })
    await signIn(user, 'sam', 'another long password')
    await screen.findByRole('button', { name: 'Logout' })
    expect(sessionStorage.getItem('retailer:session:v1')).not.toMatch(/another long password/)
    unmount()
    renderApp('/store', { authProps: {} })
    expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument()
  })
})

describe('user identity on analytics events', () => {
  it('attributes store events to the signed-in user and tenant, and none after logout', async () => {
    const user = userEvent.setup()
    renderApp('/store', SIGNED_OUT)
    await signIn(user, 'sam', 'another long password')
    await screen.findByRole('button', { name: 'Logout' })
    await user.click(within(await screen.findByRole('region', { name: 'All products' })).getByRole('button', { name: 'Add Nimbus Smartwatch to cart' }))
    expect(eventsNamed('add_to_cart')[0]).toMatchObject({ tenantId: DEFAULT_TENANT_ID, userId: SHOPPER.userId })

    await user.click(screen.getByRole('button', { name: 'Logout' }))
    await screen.findByRole('heading', { level: 1, name: 'Marketplaces' })
    expect(getRequestContext().userId).toBeNull()
  })

  it('attributes the first event after a reload to the restored session', () => {
    sessionStorage.setItem('retailer:session:v1', JSON.stringify({ ...SHOPPER, tenantId: DEFAULT_TENANT_ID }))
    renderApp('/store', { authProps: {} })
    expect(eventsNamed('home_view')[0].userId).toBe(SHOPPER.userId)
  })

  it("doesn't restore a session that belongs to another tenant's store", () => {
    sessionStorage.setItem('retailer:session:v1', JSON.stringify({ ...SHOPPER, tenantId: '33333333-3333-4333-8333-333333333333' }))
    renderApp('/store', { authProps: {} })
    expect(loginButton()).toBeInTheDocument()
    expect(eventsNamed('home_view')[0].userId).toBeNull()
  })
})
