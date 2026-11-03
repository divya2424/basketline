import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { switchTenant } from '../../api/requestContext.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { connectStore, listStores, TIERS } from './storesService.js'
import './stores.css'

const tierLabel = (id) => TIERS.find((tier) => tier.id === id)?.label ?? id

/** A full page load, so the catalog and cart start fresh for the marketplace. */
const reloadAt = (path) => window.location.assign(path)

/**
 * The marketplaces (each one a Basketline tenant, e.g. Flipkart): visit one to
 * sell or shop there, or add one (its backend onboards it at Basketline with
 * Basketline's API and keeps its API key).
 */
export function StoresPage({ navigateTo = reloadAt }) {
  const { user, logout } = useAuth()
  const [stores, setStores] = useState({ status: 'loading', items: [], error: null })
  const [attempt, setAttempt] = useState(0)
  const [created, setCreated] = useState(null)
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    listStores({ signal: controller.signal })
      .then((items) => setStores({ status: 'ready', items, error: null }))
      .catch((error) => {
        if (!controller.signal.aborted) setStores({ status: 'error', items: [], error: error.message })
      })
    return () => controller.abort()
  }, [attempt])

  // A sign-in belongs to one marketplace: visiting another signs out first.
  const open = async (store) => {
    if (user) await logout()
    switchTenant(store.tenantId, store.name)
    navigateTo(`/m/${store.tenantId}`)
  }

  return (
    <div className="container page">
      <h1>Marketplaces</h1>
      <p className="muted">Visit a marketplace to sell (as one of its sellers) or to shop there. Each is connected to Basketline with an API key of its own, which only its backend holds.</p>

      <ConnectForm
        onConnected={(result) => {
          setCreated(result)
          reload()
        }}
      />
      {created ? <Connected result={created} onOpen={() => open(created.store)} /> : null}

      <section className="stores__section" aria-labelledby="stores-heading">
        <h2 id="stores-heading">Visit a marketplace</h2>
        {stores.status === 'loading' ? (
          <p className="muted" role="status">
            <Spinner size="sm" /> Loading stores…
          </p>
        ) : stores.status === 'error' ? (
          <div className="form-error" role="alert">
            Couldn’t load the marketplaces: {stores.error}{' '}
            <Button variant="link" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : stores.items.length === 0 ? (
          <p className="muted">No marketplaces yet.</p>
        ) : (
          <ul className="stores__list">
            {stores.items.map((store) => (
              <li key={store.tenantId} className="stores__row" data-testid="store-row">
                <div>
                  <p>
                    <strong>{store.name}</strong> · {tierLabel(store.tier)}
                  </p>
                  <p className="muted">
                    <code>{store.tenantId}</code>
                  </p>
                </div>
                <Button size="sm" onClick={() => open(store)} aria-label={`Visit ${store.name}`}>
                  Visit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ConnectForm({ onConnected }) {
  const id = useId()
  const [name, setName] = useState('')
  const [tier, setTier] = useState('free')
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!name.trim()) {
      setError('Enter the marketplace’s name.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const result = await connectStore({ name: name.trim(), tier })
      setName('')
      onConnected(result)
    } catch (connectError) {
      setError(connectError.message || 'Connecting failed. Try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="stores__form" onSubmit={handleSubmit} noValidate aria-busy={pending} aria-label="Add a marketplace">
      <div className="form-field">
        <label htmlFor={`${id}-name`}>Marketplace name</label>
        <input id={`${id}-name`} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} disabled={pending} />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-tier`}>Basketline tier</label>
        <select id={`${id}-tier`} value={tier} onChange={(event) => setTier(event.target.value)} disabled={pending}>
          {TIERS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? (
          <>
            <Spinner size="sm" className="spinner--on-primary" />
            Connecting…
          </>
        ) : (
          'Add marketplace'
        )}
      </Button>
    </form>
  )
}

function Connected({ result, onOpen }) {
  const { store, users, password, seed } = result
  return (
    <section className="stores__created" role="status" aria-labelledby="connected-heading">
      <h2 id="connected-heading">{store.name} is connected</h2>
      <p>
        Basketline tenant: <code data-testid="connected-tenant-id">{store.tenantId}</code>
      </p>
      <p>
        Logins (password <code>{password}</code>): {users.map((user) => user.username).join(', ')}
      </p>
      <p>
        Seeding {seed.products} products and {seed.campaigns} active campaigns: they appear in the marketplace, and at Basketline, within a few seconds.
      </p>
      <Button onClick={onOpen}>Visit {store.name}</Button>
    </section>
  )
}
