import { useCallback, useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { useCatalog } from '../catalog/CatalogContext.jsx'
import { createCampaign, listMyCampaigns, listPlacements, setCampaignStatus } from './sellerService.js'
import './seller.css'

/**
 * The marketplace's seller portal: a signed-in seller puts its own products in
 * campaigns, one placement each (the home page's sections), pauses and resumes
 * them, and sees each campaign's results per product.
 */
export function SellerPortalPage() {
  const { user } = useAuth()
  if (user?.role !== 'seller' || !user.sellerId) {
    return (
      <div className="container page empty-state">
        <h1>Seller portal</h1>
        <p>Sign in as a seller to run campaigns for your products.</p>
      </div>
    )
  }
  return <Portal sellerId={user.sellerId} />
}

function Portal({ sellerId }) {
  const { products } = useCatalog()
  const ownProducts = products.filter((product) => product.sellerId === sellerId)
  const [placements, setPlacements] = useState([])
  const [campaigns, setCampaigns] = useState({ status: 'loading', items: [], error: null })
  const [attempt, setAttempt] = useState(0)
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([listPlacements({ signal: controller.signal }), listMyCampaigns(sellerId, { signal: controller.signal })])
      .then(([placementList, items]) => {
        setPlacements(placementList)
        setCampaigns({ status: 'ready', items, error: null })
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCampaigns({ status: 'error', items: [], error: error.message })
      })
    return () => controller.abort()
  }, [sellerId, attempt])

  const placementName = (key) => placements.find((placement) => placement.key === key)?.name ?? key

  return (
    <div className="container page">
      <h1>Seller portal</h1>
      <p className="muted">Put your products in a campaign of the type you choose (where the marketplace shows it), and see how it does.</p>
      <CreateCampaignForm placements={placements} products={ownProducts} onCreated={reload} />

      <section className="seller__section" aria-labelledby="my-campaigns">
        <h2 id="my-campaigns">My campaigns</h2>
        {campaigns.status === 'loading' ? (
          <p className="muted" role="status">
            <Spinner size="sm" /> Loading campaigns…
          </p>
        ) : campaigns.status === 'error' ? (
          <div className="form-error" role="alert">
            Couldn’t load your campaigns: {campaigns.error}{' '}
            <Button variant="link" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : campaigns.items.length === 0 ? (
          <p className="muted">No campaigns yet.</p>
        ) : (
          <ul className="campaign-cards">
            {campaigns.items.map((campaign) => (
              <CampaignCard key={campaign.id} campaign={campaign} placementName={placementName(campaign.placement)} onChanged={reload} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function CreateCampaignForm({ placements, products, onCreated }) {
  const id = useId()
  const [title, setTitle] = useState('')
  const [placement, setPlacement] = useState('')
  const [productIds, setProductIds] = useState([])
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  const chosenPlacement = placement || placements[0]?.key || ''

  const toggle = (productId) => setProductIds((ids) => (ids.includes(productId) ? ids.filter((x) => x !== productId) : [...ids, productId]))

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!title.trim() || !chosenPlacement || productIds.length === 0) {
      setError('Enter a title, choose a campaign type and at least one product.')
      return
    }
    setPending(true)
    setError(null)
    try {
      await createCampaign({ title: title.trim(), placement: chosenPlacement, status: 'active', productIds })
      setTitle('')
      setProductIds([])
      onCreated()
    } catch (createError) {
      setError(createError.message || 'Creating the campaign failed. Try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="seller__form" onSubmit={handleSubmit} noValidate aria-busy={pending} aria-label="Create a campaign">
      <div className="form-field">
        <label htmlFor={`${id}-title`}>Campaign title</label>
        <input id={`${id}-title`} value={title} maxLength={255} onChange={(event) => setTitle(event.target.value)} disabled={pending} />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-placement`}>Campaign type</label>
        <select id={`${id}-placement`} value={chosenPlacement} onChange={(event) => setPlacement(event.target.value)} disabled={pending}>
          {placements.map((option) => (
            <option key={option.key} value={option.key}>
              {option.name}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="seller__products" disabled={pending}>
        <legend>Your products</legend>
        {products.length === 0 ? <p className="muted">You have no products in the store yet.</p> : null}
        {products.map((product) => (
          <label key={product.id} className="seller__product">
            <input type="checkbox" checked={productIds.includes(product.id)} onChange={() => toggle(product.id)} />
            {product.name}
          </label>
        ))}
      </fieldset>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create campaign'}
      </Button>
    </form>
  )
}

/** A campaign at a glance: its type and status, Pause/Resume, and the way to its analytics. */
function CampaignCard({ campaign, placementName, onChanged }) {
  const [error, setError] = useState(null)
  const paused = campaign.status === 'paused'

  const toggle = async () => {
    setError(null)
    try {
      await setCampaignStatus(campaign.id, paused ? 'active' : 'paused')
      onChanged()
    } catch (actionError) {
      setError(actionError.message || 'That didn’t work. Try again.')
    }
  }

  return (
    <li className="campaign-card" data-testid="seller-campaign">
      <div className="campaign-card__body">
        <h3 className="campaign-card__title">{campaign.title}</h3>
        <p className="analytics__meta">
          <span className="tag">{placementName}</span>
          <span className={`status status--${campaign.status}`}>{campaign.status}</span>
          <span className="muted small">{campaign.productIds.length} products</span>
        </p>
      </div>
      <div className="campaign-card__actions">
        {campaign.status === 'active' || paused ? (
          <Button size="sm" variant="ghost" onClick={toggle}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
        ) : null}
        <Link className="btn btn--primary btn--sm" to={`/seller/campaigns/${campaign.id}`}>
          View analytics
        </Link>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  )
}
