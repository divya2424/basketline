import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { useCatalog } from '../catalog/CatalogContext.jsx'
import {
  addCampaignProducts,
  createCampaign,
  fetchResults,
  listMyCampaigns,
  listPlacements,
  removeCampaignProduct,
  setCampaignStatus,
} from './sellerService.js'
import './seller.css'

const percent = (value) => `${(value * 100).toFixed(1)}%`

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
          <ul className="seller__list">
            {campaigns.items.map((campaign) => (
              <CampaignRow key={campaign.id} campaign={campaign} placementName={placementName(campaign.placement)} products={ownProducts} onChanged={reload} />
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

function CampaignRow({ campaign, placementName, products, onChanged }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState('')
  const name = (productId) => products.find((product) => product.id === productId)?.name ?? productId
  const notIn = products.filter((product) => !campaign.productIds.includes(product.id))
  const paused = campaign.status === 'paused'

  const act = async (action) => {
    setError(null)
    try {
      await action()
      onChanged()
    } catch (actionError) {
      setError(actionError.message || 'That didn’t work. Try again.')
    }
  }

  return (
    <li className="seller__row" data-testid="seller-campaign">
      <div className="seller__row-head">
        <div>
          <p>
            <strong>{campaign.title}</strong> · {placementName} · {campaign.status}
          </p>
          <p className="muted">{campaign.productIds.length} products</p>
        </div>
        <div className="seller__actions">
          {campaign.status === 'active' || paused ? (
            <Button size="sm" variant="secondary" onClick={() => act(() => setCampaignStatus(campaign.id, paused ? 'active' : 'paused'))}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? 'Hide analytics' : 'Analytics'}
          </Button>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {open ? (
        <div className="seller__details">
          <Results campaignId={campaign.id} />
          <h3>Products</h3>
          <ul className="seller__campaign-products">
            {campaign.productIds.map((productId) => (
              <li key={productId}>
                {name(productId)}{' '}
                <Button size="sm" variant="link" onClick={() => act(() => removeCampaignProduct(campaign.id, productId))} aria-label={`Remove ${name(productId)}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {notIn.length > 0 ? (
            <div className="seller__add">
              <select aria-label="Product to add" value={adding} onChange={(event) => setAdding(event.target.value)}>
                <option value="">Add a product…</option>
                {notIn.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
              <Button size="sm" disabled={!adding} onClick={() => act(() => addCampaignProducts(campaign.id, [adding]).then(() => setAdding('')))}>
                Add
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

const PERIODS = [7, 30, 90]

/** The campaign's analytics for the seller's store, from Basketline through the campaign service: its totals, then per product. */
function Results({ campaignId }) {
  const [days, setDays] = useState(30)
  const [state, setState] = useState({ status: 'loading', totals: null, items: [], error: null })

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading', totals: null, items: [], error: null })
    fetchResults(campaignId, { days, signal: controller.signal })
      .then(({ totals, items }) => setState({ status: 'ready', totals, items, error: null }))
      .catch((error) => {
        if (!controller.signal.aborted) setState({ status: 'error', totals: null, items: [], error: error.message })
      })
    return () => controller.abort()
  }, [campaignId, days])

  const periods = (
    <div className="seller__periods" role="group" aria-label="Period">
      {PERIODS.map((n) => (
        <Button key={n} size="sm" variant={n === days ? 'primary' : 'ghost'} aria-pressed={n === days} onClick={() => setDays(n)}>
          {n} days
        </Button>
      ))}
    </div>
  )
  if (state.status === 'loading') {
    return (
      <>
        {periods}
        <p className="muted" role="status">
          <Spinner size="sm" /> Loading analytics…
        </p>
      </>
    )
  }
  if (state.status === 'error') return <p className="form-error" role="alert">Couldn’t load the analytics: {state.error}</p>
  const { totals } = state
  const cards = [
    ['Impressions', totals.impressions],
    ['Clicks', totals.clicks],
    ['CTR', percent(totals.ctr)],
    ['Add-to-carts', totals.addToCarts],
    ['Click-to-basket', percent(totals.clickToBasket)],
    ['Unique customers', totals.uniqueCustomers],
    ['Sessions', totals.sessions],
    ['Converted sessions', totals.convertedSessions],
  ]
  return (
    <div className="seller__table-wrap">
      {periods}
      <dl className="seller__totals" data-testid="campaign-totals">
        {cards.map(([label, value]) => (
          <div key={label} className="seller__total">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <table className="seller__results">
        <caption>Per product, last {days} days</caption>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Impressions</th>
            <th scope="col">Clicks</th>
            <th scope="col">CTR</th>
            <th scope="col">Add-to-carts</th>
            <th scope="col">Click-to-basket</th>
          </tr>
        </thead>
        <tbody>
          {state.items.map((item) => (
            <tr key={item.productId}>
              <th scope="row">{item.name ?? item.productId}</th>
              <td>{item.impressions}</td>
              <td>{item.clicks}</td>
              <td>{percent(item.ctr)}</td>
              <td>{item.addToCarts}</td>
              <td>{percent(item.clickToBasket)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
