import { useCallback, useEffect, useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { useToast } from '../../components/common/Toast.jsx'
import { DEFAULT_TENANT_ID, getRequestContext, switchTenant } from '../../api/requestContext.js'
import { trackEvent } from '../../analytics/analytics.js'
import { EVENT_NAMES } from '../../analytics/eventSchema.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { LoginModal } from '../auth/LoginModal.jsx'
import { DEMO_PASSWORD, listAccounts, onboardTenant, ONBOARDING_USERNAME, TIERS } from './onboardingService.js'
import { TenantDetails } from './TenantDetails.jsx'
import './onboarding.css'
import { KeyReveal } from '../integration/KeyReveal.jsx'
import { SdkSnippet } from '../integration/SdkSnippet.jsx'
import '../integration/integration.css'

const tierLabel = (id) => TIERS.find((tier) => tier.id === id)?.label ?? id
const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' })

/** A full page load, so the catalog, cart and dashboard all start fresh for the new store. */
const reloadAt = (path) => window.location.assign(path)

/**
 * Onboards tenants (a name and a tier; the server generates the tenant ID) and
 * lists every tenant. Each one can be opened as its "onboarding" user (store or
 * analytics), or signed in to as any of its users. This is the platform's home
 * page (/); a tenant's store (/store) opens only after signing in to it.
 */
// fullReload: false navigates within the app instead (tests, where the catalog is fixed).
export function OnboardingPage({ navigateTo, fullReload = true }) {
  const navigate = useNavigate()
  const goTo = navigateTo ?? (fullReload ? reloadAt : navigate)
  const { user, login, logout } = useAuth()
  const showToast = useToast()
  const [accounts, setAccounts] = useState({ status: 'loading', items: [], error: null })
  const [attempt, setAttempt] = useState(0)
  const [created, setCreated] = useState(null)
  const [opening, setOpening] = useState(null)
  const [loginTarget, setLoginTarget] = useState(null) // { account, previousTenant }
  const [expanded, setExpanded] = useState(null) // the tenant whose details are open
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    listAccounts({ signal: controller.signal })
      .then((items) => setAccounts({ status: 'ready', items, error: null }))
      .catch((error) => {
        if (!controller.signal.aborted) setAccounts({ status: 'error', items: [], error: error.message })
      })
    return () => controller.abort()
  }, [attempt])

  /** Switches to the tenant, signs in as its onboarding user, and reloads at `path`. */
  const openAs = async (account, path) => {
    const { tenantId: id, tenantName: name } = getRequestContext()
    const previousTenant = { id, name }
    setOpening(account.tenantId)
    if (user) await logout()
    switchTenant(account.tenantId, account.name)
    try {
      await login(ONBOARDING_USERNAME, DEMO_PASSWORD)
      goTo(path)
    } catch (error) {
      switchTenant(previousTenant.id, previousTenant.name)
      setOpening(null)
      showToast(`Couldn’t sign in to ${account.name} as “${ONBOARDING_USERNAME}”: ${error.message} Use Log in to choose a user.`)
    }
  }

  /** Opens the sign-in dialog for the tenant; cancelling returns to the previous one. */
  const startLogin = async (account) => {
    const { tenantId: id, tenantName: name } = getRequestContext()
    const previousTenant = { id, name }
    if (user) await logout()
    switchTenant(account.tenantId, account.name)
    setLoginTarget({ account, previousTenant })
    trackEvent({ featureName: 'tenant_list', pageName: 'onboarding', eventName: EVENT_NAMES.LOGIN_CLICK, properties: {} })
  }
  /** A deleted tenant leaves the list; if the app was on it, it signs out and goes back to the default store. */
  const handleDeleted = async (account) => {
    setExpanded(null)
    if (getRequestContext().tenantId === account.tenantId) {
      if (user) await logout()
      switchTenant(DEFAULT_TENANT_ID)
    }
    if (created?.account.tenantId === account.tenantId) setCreated(null)
    showToast(`${account.name} and all of its data were deleted.`)
    reload()
  }

  const cancelLogin = useCallback(() => {
    setLoginTarget((target) => {
      if (target) switchTenant(target.previousTenant.id, target.previousTenant.name)
      return null
    })
  }, [])

  return (
    <div className="container page onboarding">
      <div className="onboarding__header">
        <h1>Onboard a tenant</h1>
        <p className="muted">
          Every user created here has the password <code>{DEMO_PASSWORD}</code>. Each tenant gets an <code>{ONBOARDING_USERNAME}</code>{' '}
          user, a campaign manager.
        </p>
      </div>

      <OnboardingForm
        onCreated={(result) => {
          setCreated(result)
          reload()
        }}
      />

      {created ? <CreatedSummary result={created} /> : null}

      <section className="onboarding__section" aria-labelledby="tenants-heading">
        <h2 id="tenants-heading">Tenants</h2>
        {accounts.status === 'loading' ? (
          <p className="muted" role="status">
            <Spinner size="sm" /> Loading tenants…
          </p>
        ) : accounts.status === 'error' ? (
          <div className="form-error" role="alert">
            Couldn’t load the tenants: {accounts.error}{' '}
            <Button variant="link" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : accounts.items.length === 0 ? (
          <p className="muted">No tenants yet.</p>
        ) : (
          <ul className="tenant-list">
            {accounts.items.map((account) => (
              <li key={account.tenantId} className="tenant-row" data-testid="tenant-row">
                <div className="tenant-row__info">
                  <p className="tenant-row__name">
                    {account.name}
                    <span className={`tier-badge tier-badge--${account.tier}`}>{tierLabel(account.tier)}</span>
                  </p>
                  <p className="tenant-row__meta muted">
                    <code>{account.tenantId}</code> · onboarded {dateFormat.format(new Date(account.createdAt))}
                  </p>
                </div>
                <div className="tenant-row__actions">
                  <Button size="sm" onClick={() => openAs(account, '/store')} disabled={opening !== null} aria-label={`Open store: ${account.name}`}>
                    {opening === account.tenantId ? 'Opening…' : 'Open store'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => openAs(account, '/analytics')} disabled={opening !== null} aria-label={`Analytics: ${account.name}`}>
                    Analytics
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => startLogin(account)} disabled={opening !== null} aria-label={`Log in: ${account.name}`}>
                    Log in
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={expanded === account.tenantId}
                    aria-controls={`tenant-details-${account.tenantId}`}
                    aria-label={`Details: ${account.name}`}
                    onClick={() => setExpanded((open) => (open === account.tenantId ? null : account.tenantId))}
                  >
                    {expanded === account.tenantId ? 'Hide details' : 'Details'}
                  </Button>
                </div>
                {expanded === account.tenantId ? (
                  <div className="tenant-row__details" id={`tenant-details-${account.tenantId}`}>
                    <TenantDetails account={account} onDeleted={handleDeleted} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {loginTarget ? (
        <LoginModal title={`Sign in to ${loginTarget.account.name}`} onClose={cancelLogin} onSignedIn={() => goTo('/store')} />
      ) : null}
    </div>
  )
}

function OnboardingForm({ onCreated }) {
  const id = useId()
  const [name, setName] = useState('')
  const [tier, setTier] = useState('free')
  const [dummyUsers, setDummyUsers] = useState(true)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!name.trim()) {
      setError('Enter the tenant’s name.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const result = await onboardTenant({ name: name.trim(), tier, dummyUsers })
      setName('')
      onCreated(result)
    } catch (onboardError) {
      setError(onboardError.message || 'Onboarding failed. Try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="onboarding-form" onSubmit={handleSubmit} noValidate aria-busy={pending} aria-label="Onboard a tenant">
      <div className="form-field">
        <label htmlFor={`${id}-name`}>Tenant name</label>
        <input id={`${id}-name`} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} disabled={pending} />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-tier`}>Tier</label>
        <select id={`${id}-tier`} value={tier} onChange={(event) => setTier(event.target.value)} disabled={pending}>
          {TIERS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <label className="onboarding-form__check">
        <input type="checkbox" checked={dummyUsers} onChange={(event) => setDummyUsers(event.target.checked)} disabled={pending} />
        Create 10 demo users (user01–user10)
      </label>
      <p className="muted onboarding-form__hint">The tenant ID is generated for you.</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? (
          <>
            <Spinner size="sm" className="spinner--on-primary" />
            Onboarding…
          </>
        ) : (
          'Onboard tenant'
        )}
      </Button>
    </form>
  )
}

function CreatedSummary({ result }) {
  const { account, users, password, apiKey, seed } = result
  return (
    <section className="onboarding-created" role="status" aria-labelledby="created-heading">
      <h2 id="created-heading">{account.name} is onboarded</h2>
      <p>
        Tenant ID: <code data-testid="created-tenant-id">{account.tenantId}</code>
      </p>
      <p>
        Users (password <code>{password}</code>): {users.map((created) => created.username).join(', ')}
      </p>
      {seed ? (
        <p>
          Seeding {seed.products} products and {seed.campaigns} active campaigns: they appear in the store within a few seconds.
        </p>
      ) : null}
      {apiKey ? (
        <div className="onboarding-created__integration">
          <h3>Integrate {account.name}’s site</h3>
          <KeyReveal apiKey={apiKey} />
          <SdkSnippet tenantId={account.tenantId} />
        </div>
      ) : null}
    </section>
  )
}
