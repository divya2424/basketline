import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../auth/AuthContext.jsx'
import { ToastProvider } from '../../components/common/Toast.jsx'
import { DEFAULT_TENANT_ID, getRequestContext, switchTenant } from '../../api/requestContext.js'
import { jsonResponse, mockFetch } from '../../test/mockFetch.js'
import { OnboardingPage } from './OnboardingPage.jsx'

const ACME = { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Acme Store', tier: 'pro', createdAt: '2026-10-28T10:00:00.000Z' }
const DEFAULT = { tenantId: DEFAULT_TENANT_ID, name: 'Default storefront', tier: 'free', createdAt: '2026-10-01T10:00:00.000Z' }
const NEW_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let api
let accounts
let navigateTo

/** The onboarding user of every tenant except `noOnboardingUser` signs in with "test". */
function startApi({ noOnboardingUser } = {}) {
  accounts = [ACME, DEFAULT]
  api = mockFetch(({ path, method, headers, body }) => {
    if (path === '/accounts' && method === 'GET') return jsonResponse(200, { items: accounts })
    if (path === '/accounts' && method === 'POST') {
      const account = { tenantId: NEW_TENANT, name: body.name, tier: body.tier, createdAt: '2026-10-29T10:00:00.000Z' }
      accounts = [account, ...accounts]
      const users = [{ username: 'onboarding', role: 'campaign-manager' }, ...(body.dummyUsers ? [{ username: 'user01', role: 'standard-user' }] : [])]
      return jsonResponse(201, { account, users, password: 'test' })
    }
    if (path === '/auth/login') {
      const tenant = headers.get('tenant_id')
      if (body.password !== 'test' || (body.username === 'onboarding' && tenant === noOnboardingUser)) {
        return jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } })
      }
      return jsonResponse(200, {
        accessToken: `token-${tenant}`,
        user: { id: '44444444-4444-4444-8444-444444444444', username: body.username, role: 'campaign-manager', tenantId: tenant },
        session: { expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
      })
    }
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
  })
}

function renderPage() {
  navigateTo = vi.fn()
  return render(
    <MemoryRouter>
      <AuthProvider persist={false}>
        <ToastProvider>
          <OnboardingPage navigateTo={navigateTo} />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const row = async (name) => (await screen.findAllByTestId('tenant-row')).find((element) => within(element).queryByText(name))
const logins = () => api.requests.filter((request) => request.path === '/auth/login')

beforeEach(() => startApi())
afterEach(() => {
  api.restore()
  switchTenant(DEFAULT_TENANT_ID)
  localStorage.clear()
})

describe('onboarding a tenant', () => {
  it('posts the name, tier and demo-users choice, then shows the generated tenant ID and lists the tenant', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByLabelText('Tenant name'), '  Globex ')
    await user.selectOptions(screen.getByLabelText('Tier'), 'enterprise')
    await user.click(screen.getByRole('button', { name: 'Onboard tenant' }))

    expect(await screen.findByTestId('created-tenant-id')).toHaveTextContent(NEW_TENANT)
    const post = api.requests.find((request) => request.method === 'POST' && request.path === '/accounts')
    expect(post.body).toEqual({ name: 'Globex', tier: 'enterprise', dummyUsers: true })
    expect(screen.getByText(/onboarding, user01/)).toBeInTheDocument()
    expect(await row('Globex')).toBeDefined()
  })

  it('asks for a name before sending anything', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Onboard tenant' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the tenant’s name.')
    expect(api.requests.some((request) => request.method === 'POST')).toBe(false)
  })
})

describe('the tenant list', () => {
  it('lists every tenant with its tier and ID', async () => {
    renderPage()
    const acme = await row('Acme Store')
    expect(within(acme).getByText('Pro')).toBeInTheDocument()
    expect(within(acme).getByText(ACME.tenantId)).toBeInTheDocument()
    expect(within(await row('Default storefront')).getByText('Free')).toBeInTheDocument()
  })

  it.each([
    ['Open store', '/store'],
    ['Analytics', '/analytics'],
  ])('%s switches to the tenant, signs in as its onboarding user and opens %s', async (button, path) => {
    const user = userEvent.setup()
    renderPage()
    await user.click(within(await row('Acme Store')).getByRole('button', { name: `${button}: Acme Store` }))

    await vi.waitFor(() => expect(navigateTo).toHaveBeenCalledWith(path))
    expect(logins()[0]).toMatchObject({ body: { username: 'onboarding', password: 'test', clientType: 'web' } })
    expect(logins()[0].headers.get('tenant_id')).toBe(ACME.tenantId)
    expect(getRequestContext().tenantId).toBe(ACME.tenantId)
    expect(localStorage.getItem('ecommerce-analytics:tenant')).toBe(ACME.tenantId)
    expect(getRequestContext().tenantName).toBe('Acme Store')
  })

  it('stays on the current store when the tenant has no onboarding user', async () => {
    api.restore()
    startApi({ noOnboardingUser: ACME.tenantId })
    const user = userEvent.setup()
    renderPage()
    await user.click(within(await row('Acme Store')).getByRole('button', { name: 'Open store: Acme Store' }))

    expect(await screen.findByText(/Couldn’t sign in to Acme Store as “onboarding”/)).toBeInTheDocument()
    expect(navigateTo).not.toHaveBeenCalled()
    expect(getRequestContext().tenantId).toBe(DEFAULT_TENANT_ID)
  })

  it("Log in opens the tenant's sign-in dialog; signing in opens its store", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(within(await row('Acme Store')).getByRole('button', { name: 'Log in: Acme Store' }))

    const dialog = screen.getByRole('dialog', { name: 'Sign in to Acme Store' })
    await user.type(within(dialog).getByLabelText('Username'), 'user03')
    await user.type(within(dialog).getByLabelText('Password'), 'test')
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }))

    await vi.waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/store'))
    expect(logins()[0].body).toMatchObject({ username: 'user03', password: 'test' })
    expect(logins()[0].headers.get('tenant_id')).toBe(ACME.tenantId)
  })

  it('cancelling the sign-in dialog returns to the previous store', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(within(await row('Acme Store')).getByRole('button', { name: 'Log in: Acme Store' }))
    expect(getRequestContext().tenantId).toBe(ACME.tenantId)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(getRequestContext().tenantId).toBe(DEFAULT_TENANT_ID)
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('shows an error with a retry when the list fails to load', async () => {
    api.restore()
    api = mockFetch(() => jsonResponse(500, { error: { code: 'INTERNAL', message: 'Something went wrong' } }))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the tenants: Something went wrong')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
