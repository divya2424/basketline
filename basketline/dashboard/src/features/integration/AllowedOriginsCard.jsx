import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { listAllowedOrigins, setAllowedOrigins } from './integrationService.js'

const defaultService = { listAllowedOrigins, setAllowedOrigins }

/**
 * The websites whose pages may send the store's events through the SDK; with
 * none, any website may (anyone who copies the tenant ID). `service` makes the
 * calls (the signed-in manager's by default); the list loads once `active`.
 */
export function AllowedOriginsCard({ service = defaultService, active = true }) {
  const inputId = useId()
  const [origins, setOrigins] = useState({ status: 'loading', items: [], error: null })
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setOrigins({ status: 'success', items: await service.listAllowedOrigins(), error: null })
    } catch (failure) {
      setOrigins({ status: 'error', items: [], error: failure.message })
    }
  }, [service])

  useEffect(() => {
    if (active) load()
  }, [active, load])

  async function save(next) {
    setBusy(true)
    setError(null)
    try {
      setOrigins({ status: 'success', items: await service.setAllowedOrigins(next), error: null })
      return true
    } catch (failure) {
      setError(failure.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function add(event) {
    event.preventDefault()
    if (await save([...origins.items, address.trim()])) setAddress('')
  }

  return (
    <div className="api-keys">
      <p className="small muted">
        Only pages on these websites can send your store’s events. Calls from your servers and mobile apps aren’t affected.
      </p>
      <form className="integration__form" onSubmit={add}>
        <label className="visually-hidden" htmlFor={inputId}>
          Website address
        </label>
        <input
          id={inputId}
          placeholder="https://shop.example"
          value={address}
          maxLength={200}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button type="submit" disabled={!address.trim() || busy || origins.status !== 'success'}>
          Add website
        </Button>
      </form>
      {error ? (
        <p className="cell-error small" role="alert">
          {error}
        </p>
      ) : null}
      {origins.status === 'loading' ? (
        <Spinner size="sm" label="Loading allowed websites" />
      ) : origins.status === 'error' ? (
        <p className="cell-error small" role="alert">
          Couldn’t load the allowed websites: {origins.error}{' '}
          <Button variant="link" size="sm" onClick={load}>
            Retry
          </Button>
        </p>
      ) : origins.items.length === 0 ? (
        <p className="small origins-open">
          Any website can send events for your store. Add your site’s address to allow only it.
        </p>
      ) : (
        <ul className="key-list" aria-label="Allowed websites">
          {origins.items.map((origin) => (
            <li key={origin} className="key-list__item">
              <code>{origin}</code>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => save(origins.items.filter((item) => item !== origin))}
                aria-label={`Remove ${origin}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
