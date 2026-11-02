import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { switchTenant } from '../../api/requestContext.js'
import { connectStore, listStores, TIERS } from './storesService.js'
import './stores.css'

const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL || 'http://localhost:5173'
const tierLabel = (id) => TIERS.find((tier) => tier.id === id)?.label ?? id

/** A full page load, so the catalog and cart start fresh for the store. */
const reloadAt = (path) => window.location.assign(path)

/**
 * The retailer's stores: connect a new one to Basketline (the store's backend
 * onboards it there with Basketline's API and keeps its API key), or open one.
 */
export function StoresPage({ navigateTo = reloadAt }) {
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

  const open = (store) => {
    switchTenant(store.tenantId, store.name)
    navigateTo('/store')
  }

  return (
    <div className="container page">
      <h1>Stores</h1>
      <p className="muted">Each store is connected to Basketline with an API key of its own, which only this retailer’s backend holds.</p>

      <ConnectForm
        onConnected={(result) => {
          setCreated(result)
          reload()
        }}
      />
      {created ? <Connected result={created} onOpen={() => open(created.store)} /> : null}

      <section className="stores__section" aria-labelledby="stores-heading">
        <h2 id="stores-heading">Connected stores</h2>
        {stores.status === 'loading' ? (
          <p className="muted" role="status">
            <Spinner size="sm" /> Loading stores…
          </p>
        ) : stores.status === 'error' ? (
          <div className="form-error" role="alert">
            Couldn’t load the stores: {stores.error}{' '}
            <Button variant="link" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : stores.items.length === 0 ? (
          <p className="muted">No stores yet.</p>
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
                <Button size="sm" onClick={() => open(store)} aria-label={`Open ${store.name}`}>
                  Open
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
      setError('Enter the store’s name.')
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
    <form className="stores__form" onSubmit={handleSubmit} noValidate aria-busy={pending} aria-label="Connect a store to Basketline">
      <div className="form-field">
        <label htmlFor={`${id}-name`}>Store name</label>
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
          'Connect to Basketline'
        )}
      </Button>
    </form>
  )
}

function Connected({ result, onOpen }) {
  const { store, users, password, basketlineUsers, basketlinePassword, seed } = result
  return (
    <section className="stores__created" role="status" aria-labelledby="connected-heading">
      <h2 id="connected-heading">{store.name} is connected</h2>
      <p>
        Basketline tenant: <code data-testid="connected-tenant-id">{store.tenantId}</code>
      </p>
      <p>
        Store logins (password <code>{password}</code>): {users.map((user) => user.username).join(', ')}
      </p>
      <p>
        Basketline dashboard (password <code>{basketlinePassword}</code>): {basketlineUsers.map((user) => user.username).join(', ')}, at{' '}
        <a href={DASHBOARD_URL}>{DASHBOARD_URL}</a>
      </p>
      <p>
        Seeding {seed.products} products and {seed.campaigns} active campaigns: they appear in the store, and at Basketline, within a few seconds.
      </p>
      <Button onClick={onOpen}>Open {store.name}</Button>
    </section>
  )
}
