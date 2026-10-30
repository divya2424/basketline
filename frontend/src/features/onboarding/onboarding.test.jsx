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
      return jsonResponse(201, { account, users, password: 'test', apiKey: { key: 'bl_sk_FirstKeySECRET', prefix: 'bl_sk_FirstK', name: 'Default' } })
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
    // A tenant's keys, for its own manager's token only.
    if (path === '/auth/api-keys' && method === 'GET') {
      if (headers.get('Authorization') !== `Bearer token-${headers.get('tenant_id')}`) return jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } })
      return jsonResponse(200, { items: [{ prefix: 'bl_sk_AcmeKy', name: 'Default', createdAt: '2026-10-28T10:00:00.000Z', revokedAt: null }] })
    }
    if (path === '/auth/allowed-origins' && method === 'GET') return jsonResponse(200, { origins: ['https://acme.example'] })
    const deleting = path.match(/^\/accounts\/([^/]+)$/)
    if (deleting && method === 'DELETE') {
      const account = accounts.find((a) => a.tenantId === deleting[1])
      if (body.confirmName !== account.name) return jsonResponse(400, { error: { code: 'CONFIRMATION_MISMATCH', message: "confirmName doesn't match" } })
      accounts = accounts.filter((a) => a !== account)
      return jsonResponse(200, { deleted: { tenantId: account.tenantId, name: account.name, deletedAt: new Date().toISOString() } })
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

describe("a tenant's details", () => {
  it("shows its SDK setup and its API keys as its manager, without switching the app to it", async () => {
    switchTenant(DEFAULT_TENANT_ID)
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Details: Acme Store' }))
    const details = await screen.findByRole('region', { name: 'API keys of Acme Store' })
    expect(await within(details).findByRole('list', { name: 'API keys' })).toHaveTextContent('Default')
    expect(screen.getByLabelText('SDK setup code')).toHaveTextContent(`tenantId: '${ACME.tenantId}'`)
    expect(getRequestContext().tenantId).toBe(DEFAULT_TENANT_ID)
    const websites = await screen.findByRole('region', { name: 'Allowed websites of Acme Store' })
    expect(await within(websites).findByRole('list', { name: 'Allowed websites' })).toHaveTextContent('https://acme.example')
    expect(screen.getByRole('button', { name: 'Details: Acme Store' })).toHaveAttribute('aria-expanded', 'true')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(logins()).toHaveLength(1)
  })

  it("explains when the tenant has no onboarding user to sign in as", async () => {
    api.restore()
    startApi({ noOnboardingUser: ACME.tenantId })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Details: Acme Store' }))
    const details = await screen.findByRole('region', { name: 'API keys of Acme Store' })
    expect(await within(details).findByRole('alert')).toHaveTextContent('manage its keys with the CLI')
  })

  it('deletes the tenant only once its name is typed exactly, then drops it from the list', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Details: Acme Store' }))
    await user.click(screen.getByRole('button', { name: 'Delete tenant…' }))
    const confirm = screen.getByLabelText(/Type Acme Store to confirm/)
    const remove = screen.getByRole('button', { name: 'Delete Acme Store' })
    await user.type(confirm, 'acme store')
    expect(remove).toBeDisabled()
    await user.clear(confirm)
    await user.type(confirm, 'Acme Store')
    await user.click(remove)

    expect(await screen.findByText('Acme Store and all of its data were deleted.')).toBeInTheDocument()
    const call = api.requests.find((r) => r.method === 'DELETE')
    expect(call).toMatchObject({ path: `/accounts/${ACME.tenantId}`, body: { confirmName: 'Acme Store' } })
    await screen.findAllByTestId('tenant-row')
    expect(screen.queryByText('Acme Store')).not.toBeInTheDocument()
  })
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
    // The vendor's first API key, shown once, and the SDK setup for this tenant.
    expect(screen.getByTestId('api-key-secret')).toHaveTextContent('bl_sk_FirstKeySECRET')
    expect(screen.getByLabelText('SDK setup code')).toHaveTextContent(`tenantId: '${NEW_TENANT}'`)
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
    expect(localStorage.getItem('basketline:tenant')).toBe(ACME.tenantId)
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
