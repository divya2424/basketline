import { useEffect, useId, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { getRequestContext } from '../../api/requestContext.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { useCatalog } from '../catalog/CatalogContext.jsx'
import { DEMO_PASSWORD, fetchAccounts } from './marketplaceService.js'
import './marketplace.css'

/**
 * A marketplace's front door (the one opened from the Marketplaces page): sell,
 * signed in as one of its sellers, who runs campaigns and sees their analytics;
 * or shop, as a visitor or signed in as one of its shoppers.
 */
export function MarketplacePage() {
  const { tenantId } = useParams()
  // The Marketplaces page switches the tenant before opening this page.
  if (tenantId !== getRequestContext().tenantId) return <Navigate to="/" replace />
  return <Marketplace />
}

function Marketplace() {
  const navigate = useNavigate()
  const { products } = useCatalog()
  const [accounts, setAccounts] = useState({ status: 'loading', sellers: [], shoppers: [], error: null })
  const [chosen, setChosen] = useState(null)
  const name = getRequestContext().tenantName ?? 'This marketplace'

  useEffect(() => {
    const controller = new AbortController()
    fetchAccounts({ signal: controller.signal })
      .then(({ sellers, shoppers }) => setAccounts({ status: 'ready', sellers, shoppers, error: null }))
      .catch((error) => {
        if (!controller.signal.aborted) setAccounts({ status: 'error', sellers: [], shoppers: [], error: error.message })
      })
    return () => controller.abort()
  }, [])

  if (accounts.status === 'loading') {
    return (
      <div className="container page page-loading" role="status">
        <Spinner size="lg" />
        <p className="muted">Loading {name}…</p>
      </div>
    )
  }
  if (accounts.status === 'error') {
    return (
      <div className="container page empty-state" role="alert">
        <p>Couldn’t load {name}: {accounts.error}</p>
      </div>
    )
  }
  const productCount = (sellerId) => products.filter((product) => product.sellerId === sellerId).length

  return (
    <div className="container page">
      <h1>{name}</h1>
      <div className="marketplace__doors">
        <section className="marketplace__door" aria-labelledby="sell-heading">
          <h2 id="sell-heading">Sell</h2>
          <p className="muted">Sign in as one of {name}’s sellers to run campaigns for your products and see their analytics.</p>
          <ul className="marketplace__accounts">
            {accounts.sellers.map((seller) => (
              <li key={seller.username}>
                <Button variant="secondary" onClick={() => setChosen(seller)} aria-label={`Sign in as ${seller.name}`}>
                  {seller.name}
                </Button>
                <span className="muted small">
                  {seller.username} · {productCount(seller.sellerId)} products
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="marketplace__door" aria-labelledby="shop-heading">
          <h2 id="shop-heading">Shop</h2>
          <p className="muted">Browse and buy as a shopper. What you do here is what sellers see in their analytics.</p>
          <Button onClick={() => navigate('/store')}>Browse as a visitor</Button>
          <ul className="marketplace__accounts marketplace__accounts--inline">
            {accounts.shoppers.map((shopper) => (
              <li key={shopper.username}>
                <Button variant="ghost" size="sm" onClick={() => setChosen(shopper)} aria-label={`Sign in as ${shopper.username}`}>
                  {shopper.username}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {chosen ? <SignIn account={chosen} onClose={() => setChosen(null)} onSignedIn={() => navigate(chosen.role === 'seller' ? '/seller' : '/store')} /> : null}
    </div>
  )
}

/** Signs in as the chosen account: its username fixed, the demo password filled in. */
function SignIn({ account, onClose, onSignedIn }) {
  const id = useId()
  const { login } = useAuth()
  const [password, setPassword] = useState(DEMO_PASSWORD)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await login(account.username, password)
      onSignedIn()
    } catch (loginError) {
      setError(loginError.message)
      setPending(false)
    }
  }

  return (
    <form className="marketplace__signin" onSubmit={handleSubmit} aria-label={`Sign in as ${account.name ?? account.username}`}>
      <h2>Sign in as {account.name ?? account.username}</h2>
      <div className="form-field">
        <label htmlFor={`${id}-username`}>Username</label>
        <input id={`${id}-username`} value={account.username} readOnly />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-password`}>Password</label>
        <input id={`${id}-password`} type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={pending} />
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="marketplace__signin-actions">
        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
