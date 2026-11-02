import { useEffect, useId, useState } from 'react'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { ApiKeysCard } from '../integration/ApiKeysPanel.jsx'
import { AllowedOriginsCard } from '../integration/AllowedOriginsCard.jsx'
import { integrationAs } from '../integration/integrationService.js'
import { SdkSnippet } from '../integration/SdkSnippet.jsx'
import { deleteTenant, managerTokenFor, ONBOARDING_USERNAME } from './onboardingService.js'

// Module-level: a default created per render would re-run the sign-in effect forever.
const defaultServices = { managerTokenFor, integrationAs, deleteTenant }

/**
 * One tenant's details on the onboarding page: its SDK setup, its API keys and
 * allowed websites (as
 * its onboarding campaign manager, signed in for this panel only: the app stays
 * on its current tenant) and deleting it. `services` is for tests.
 */
export function TenantDetails({ account, onDeleted, services = defaultServices }) {
  const [keys, setKeys] = useState({ status: 'loading', service: null, error: null })

  useEffect(() => {
    let cancelled = false
    services
      .managerTokenFor(account.tenantId)
      .then((token) => !cancelled && setKeys({ status: 'ready', service: services.integrationAs({ tenantId: account.tenantId, token }), error: null }))
      .catch((error) => !cancelled && setKeys({ status: 'error', service: null, error: error.message }))
    return () => {
      cancelled = true
    }
  }, [account.tenantId, services])

  return (
    <div className="tenant-details">
      <section className="tenant-details__section" aria-label={`Integrate ${account.name}`}>
        <h3>Integrate {account.name}’s site</h3>
        <SdkSnippet tenantId={account.tenantId} />
      </section>

      <section className="tenant-details__section" aria-label={`API keys of ${account.name}`}>
        <h3>API keys</h3>
        {keys.status === 'loading' ? (
          <Spinner size="sm" label="Signing in to see the API keys" />
        ) : keys.status === 'error' ? (
          <p className="small muted" role="alert">
            Couldn’t sign in as “{ONBOARDING_USERNAME}” to show the keys: {keys.error} A tenant created with the CLI has no{' '}
            {ONBOARDING_USERNAME} user; manage its keys with the CLI.
          </p>
        ) : (
          <ApiKeysCard service={keys.service} />
        )}
      </section>

      {keys.status === 'ready' ? (
        <section className="tenant-details__section" aria-label={`Allowed websites of ${account.name}`}>
          <h3>Allowed websites</h3>
          <AllowedOriginsCard service={keys.service} />
        </section>
      ) : null}

      <DeleteTenant account={account} onDeleted={onDeleted} deleteTenant={services.deleteTenant} />
    </div>
  )
}

/** Deleting asks for the tenant's name, typed again: everything it owns goes, for good. */
function DeleteTenant({ account, onDeleted, deleteTenant }) {
  const inputId = useId()
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [state, setState] = useState({ busy: false, error: null })
  const matches = typed.trim() === account.name

  async function submit(event) {
    event.preventDefault()
    setState({ busy: true, error: null })
    try {
      await deleteTenant(account.tenantId, typed)
      onDeleted(account)
    } catch (error) {
      setState({ busy: false, error: error.message })
    }
  }

  return (
    <section className="tenant-details__section tenant-details__danger" aria-label={`Delete ${account.name}`}>
      <h3>Delete tenant</h3>
      <p className="small">
        Deletes <strong>{account.name}</strong> and everything it owns, for good: its users and sign-ins, API keys, products,
        campaigns, all of its analytics, and its archived events.
      </p>
      {!confirming ? (
        <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
          Delete tenant…
        </Button>
      ) : (
        <form className="tenant-details__confirm" onSubmit={submit}>
          <label htmlFor={inputId} className="small">
            Type <strong>{account.name}</strong> to confirm
          </label>
          <input id={inputId} value={typed} autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
          <div className="tenant-details__confirm-actions">
            <Button type="submit" variant="danger" size="sm" disabled={!matches || state.busy}>
              {state.busy ? 'Deleting…' : `Delete ${account.name}`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirming(false)
                setTyped('')
              }}
            >
              Cancel
            </Button>
          </div>
          {state.error ? (
            <p className="cell-error small" role="alert">
              {state.error}
            </p>
          ) : null}
        </form>
      )}
    </section>
  )
}
