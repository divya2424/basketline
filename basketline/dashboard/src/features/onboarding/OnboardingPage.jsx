import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { useToast } from '../../components/common/Toast.jsx'
import { DEFAULT_TENANT_ID, getRequestContext, switchTenant } from '../../api/requestContext.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { LoginModal } from '../auth/LoginModal.jsx'
import { DEMO_PASSWORD, listAccounts, ONBOARDING_USERNAME, TIERS } from './onboardingService.js'
import { TenantDetails } from './TenantDetails.jsx'
import './onboarding.css'

const tierLabel = (id) => TIERS.find((tier) => tier.id === id)?.label ?? id
const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' })

/** A full page load, so the catalog and dashboard start fresh for the new tenant. */
const reloadAt = (path) => window.location.assign(path)

/** The retailer's storefront (retailer-sim/storefront), opened on the tenant's store; visitors need no sign-in there. */
const STOREFRONT_URL = import.meta.env.VITE_STOREFRONT_URL || 'http://localhost:5174'
export const storefrontUrl = (account) => `${STOREFRONT_URL}/store?${new URLSearchParams({ tenant: account.tenantId, name: account.name })}`

/**
 * Lists every tenant. Retailers onboard with Basketline's API (POST /accounts);
 * the simulated retailer does it from its storefront's Stores page. Each
 * tenant's dashboard opens as its "onboarding" user or after signing in as any
 * of its users; its store opens in the storefront. This is the platform's home page (/).
 */
// fullReload: false navigates within the app instead (tests, where the catalog is fixed).
export function OnboardingPage({ navigateTo, fullReload = true }) {
  const navigate = useNavigate()
  const goTo = navigateTo ?? (fullReload ? reloadAt : navigate)
  const { user, login, logout } = useAuth()
  const showToast = useToast()
  const [accounts, setAccounts] = useState({ status: 'loading', items: [], error: null })
  const [attempt, setAttempt] = useState(0)
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
  }
  /** A deleted tenant leaves the list; if the app was on it, it signs out and goes back to the default tenant. */
  const handleDeleted = async (account) => {
    setExpanded(null)
    if (getRequestContext().tenantId === account.tenantId) {
      if (user) await logout()
      switchTenant(DEFAULT_TENANT_ID)
    }
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
        <h1 id="tenants-heading">Tenants</h1>
        <p className="muted">
          Retailers onboard with Basketline’s API (<code>POST /accounts</code>), keeping the API key it returns. The simulated retailer does
          it from its storefront’s <a href={`${STOREFRONT_URL}/stores`}>Stores</a> page. Each tenant has an <code>{ONBOARDING_USERNAME}</code>{' '}
          user, its campaign manager, with the password <code>{DEMO_PASSWORD}</code>.
        </p>
      </div>

      <section className="onboarding__section" aria-labelledby="tenants-heading">
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
                  <Button size="sm" onClick={() => goTo(storefrontUrl(account))} disabled={opening !== null} aria-label={`Open store: ${account.name}`}>
                    Open store
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => openAs(account, '/analytics')} disabled={opening !== null} aria-label={`Analytics: ${account.name}`}>
                    {opening === account.tenantId ? 'Opening…' : 'Analytics'}
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
        <LoginModal title={`Sign in to ${loginTarget.account.name}`} onClose={cancelLogin} onSignedIn={() => goTo('/analytics')} />
      ) : null}
    </div>
  )
}
