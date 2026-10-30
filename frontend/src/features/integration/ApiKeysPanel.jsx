import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { getRequestContext } from '../../api/requestContext.js'
import { AllowedOriginsCard } from './AllowedOriginsCard.jsx'
import { createApiKey, listApiKeys, revokeApiKey } from './integrationService.js'
import { KeyReveal } from './KeyReveal.jsx'
import { SdkSnippet } from './SdkSnippet.jsx'
import './integration.css'

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })
const defaultService = { listApiKeys, createApiKey, revokeApiKey }

/**
 * A store's API keys: create (shown once), list, revoke. `service` makes the
 * calls (the signed-in manager's by default); keys load once `active`.
 */
export function ApiKeysCard({ service = defaultService, active = true }) {
  const inputId = useId()
  const [keys, setKeys] = useState({ status: 'loading', items: [], error: null })
  const [name, setName] = useState('')
  const [created, setCreated] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setKeys({ status: 'success', items: await service.listApiKeys(), error: null })
    } catch (failure) {
      setKeys({ status: 'error', items: [], error: failure.message })
    }
  }, [service])

  useEffect(() => {
    if (active) load()
  }, [active, load])

  async function create(event) {
    event.preventDefault()
    setBusy('create')
    setError(null)
    try {
      setCreated(await service.createApiKey(name.trim()))
      setName('')
      await load()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(null)
    }
  }

  async function revoke(prefix) {
    setBusy(prefix)
    setError(null)
    try {
      await service.revokeApiKey(prefix)
      if (created?.prefix === prefix) setCreated(null)
      await load()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="api-keys">
      <p className="small muted">Your backend uses a key to identify signed-in shoppers. Revoke a key if it leaks.</p>
      {created ? <KeyReveal apiKey={created} /> : null}
      <form className="integration__form" onSubmit={create}>
        <label className="visually-hidden" htmlFor={inputId}>
          Key name
        </label>
        <input
          id={inputId}
          placeholder="Key name, e.g. Production web"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={!name.trim() || busy === 'create'}>
          {busy === 'create' ? 'Creating…' : 'Create key'}
        </Button>
      </form>
      {error ? (
        <p className="cell-error small" role="alert">
          {error}
        </p>
      ) : null}
      {keys.status === 'loading' ? (
        <Spinner size="sm" label="Loading API keys" />
      ) : keys.status === 'error' ? (
        <p className="cell-error small" role="alert">
          Couldn’t load API keys: {keys.error}{' '}
          <Button variant="link" size="sm" onClick={load}>
            Retry
          </Button>
        </p>
      ) : keys.items.length === 0 ? (
        <p className="small muted">No API keys yet.</p>
      ) : (
        <ul className="key-list" aria-label="API keys">
          {keys.items.map((key) => (
            <li key={key.prefix} className={key.revokedAt ? 'key-list__item key-list__item--revoked' : 'key-list__item'}>
              <div>
                <strong>{key.name}</strong>
                <span className="small muted block">
                  <code>{key.prefix}…</code> · created {dateFormat.format(new Date(key.createdAt))}
                  {key.revokedAt ? ` · revoked ${dateFormat.format(new Date(key.revokedAt))}` : ''}
                </span>
              </div>
              {key.revokedAt ? (
                <span className="key-list__badge">Revoked</span>
              ) : (
                <Button variant="secondary" size="sm" disabled={busy === key.prefix} onClick={() => revoke(key.prefix)} aria-label={`Revoke ${key.name}`}>
                  {busy === key.prefix ? 'Revoking…' : 'Revoke'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Integrating the signed-in manager's store: the SDK setup, its API keys and its
 * allowed websites, in a section at the bottom of the dashboard, loaded only when opened.
 */
export function ApiKeysPanel({ service = defaultService, originsService }) {
  const { tenantId } = getRequestContext()
  const [open, setOpen] = useState(false)
  return (
    <details className="integration" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="integration__summary">
        <span className="section-head__title">Integrate your site</span>
        <span className="small muted">SDK setup, API keys and allowed websites</span>
      </summary>
      <div className="integration__grid">
        <article className="integration__card">
          <h3>1. Add the SDK</h3>
          <SdkSnippet tenantId={tenantId} />
        </article>
        <article className="integration__card">
          <h3>2. API keys</h3>
          <ApiKeysCard service={service} active={open} />
        </article>
        <article className="integration__card">
          <h3>3. Allowed websites</h3>
          <AllowedOriginsCard service={originsService} active={open} />
        </article>
      </div>
    </details>
  )
}
