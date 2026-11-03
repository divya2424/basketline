import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { useCatalog } from '../catalog/CatalogContext.jsx'
import { FunnelBars, KpiCard, PeriodSwitch, SplitBar, formatNumber, formatPercent } from './analyticsParts.jsx'
import { addCampaignProducts, fetchCampaign, fetchResults, listPlacements, removeCampaignProduct, setCampaignStatus } from './sellerService.js'
import './seller.css'

/**
 * One campaign's analytics for its seller: headline numbers, the funnel from
 * impression to add-to-cart, where the interactions came from (web or mobile
 * app), and every product's results; then its products, to add or remove.
 * From Basketline through the campaign service, for the seller's store.
 */
export function CampaignAnalyticsPage() {
  const { campaignId } = useParams()
  const { user } = useAuth()
  const [campaign, setCampaign] = useState({ status: 'loading', value: null, placementName: '', error: null })
  const [attempt, setAttempt] = useState(0)
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([fetchCampaign(campaignId, { signal: controller.signal }), listPlacements({ signal: controller.signal })])
      .then(([value, placements]) =>
        setCampaign({ status: 'ready', value, placementName: placements.find((p) => p.key === value.placement)?.name ?? value.placement, error: null }),
      )
      .catch((error) => {
        if (!controller.signal.aborted) setCampaign({ status: 'error', value: null, placementName: '', error: error.message })
      })
    return () => controller.abort()
  }, [campaignId, attempt])

  if (user?.role !== 'seller') {
    return (
      <div className="container page empty-state">
        <p>Sign in as a seller to see your campaigns’ analytics.</p>
      </div>
    )
  }
  if (campaign.status === 'loading') {
    return (
      <div className="container page page-loading" role="status">
        <Spinner size="lg" />
      </div>
    )
  }
  if (campaign.status === 'error') {
    return (
      <div className="container page empty-state" role="alert">
        <p>Couldn’t load the campaign: {campaign.error}</p>
        <Link to="/seller">← My campaigns</Link>
      </div>
    )
  }
  return <Analytics campaign={campaign.value} placementName={campaign.placementName} onChanged={reload} />
}

function Analytics({ campaign, placementName, onChanged }) {
  const [days, setDays] = useState(30)
  const [results, setResults] = useState({ status: 'loading', data: null, error: null })
  const [error, setError] = useState(null)
  const paused = campaign.status === 'paused'

  useEffect(() => {
    const controller = new AbortController()
    setResults({ status: 'loading', data: null, error: null })
    fetchResults(campaign.id, { days, signal: controller.signal })
      .then((data) => setResults({ status: 'ready', data, error: null }))
      .catch((loadError) => {
        if (!controller.signal.aborted) setResults({ status: 'error', data: null, error: loadError.message })
      })
    return () => controller.abort()
  }, [campaign.id, days])

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
    <div className="container page analytics">
      <Link to="/seller" className="analytics__back">
        ← My campaigns
      </Link>
      <header className="analytics__header">
        <div>
          <h1 className="analytics__title">{campaign.title}</h1>
          <p className="analytics__meta">
            <span className="tag">{placementName}</span>
            <span className={`status status--${campaign.status}`}>{campaign.status}</span>
          </p>
        </div>
        <div className="analytics__controls">
          {campaign.status === 'active' || paused ? (
            <Button variant="secondary" onClick={() => act(() => setCampaignStatus(campaign.id, paused ? 'active' : 'paused'))}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
          ) : null}
          <PeriodSwitch days={days} onChange={setDays} />
        </div>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {results.status === 'loading' ? (
        <p className="muted" role="status">
          <Spinner size="sm" /> Loading analytics…
        </p>
      ) : results.status === 'error' ? (
        <p className="form-error" role="alert">
          Couldn’t load the analytics: {results.error}
        </p>
      ) : (
        <Report data={results.data} days={days} />
      )}

      <ManageProducts campaign={campaign} act={act} />
    </div>
  )
}

function Report({ data, days }) {
  const { totals, byClient, bothClients, items } = data
  const active = items.filter((item) => item.impressions > 0 || item.clicks > 0 || item.addToCarts > 0)
  const quiet = items.length - active.length
  const topCtr = Math.max(0, ...items.map((item) => item.ctr))
  return (
    <>
      <section aria-labelledby="overview-heading" className="analytics__section">
        <h2 id="overview-heading" className="analytics__heading">
          Overview <span className="muted small">· last {days} days</span>
        </h2>
        <dl className="kpis" data-testid="campaign-totals">
          <KpiCard label="Impressions" value={formatNumber(totals.impressions)} note="times its products were shown" />
          <KpiCard label="Clicks" value={formatNumber(totals.clicks)} note={`${formatPercent(totals.ctr)} click-through rate`} />
          <KpiCard label="Add-to-carts" value={formatNumber(totals.addToCarts)} note={`${formatPercent(totals.clickToBasket)} of clicks`} />
          <KpiCard label="Unique customers" value={formatNumber(totals.uniqueCustomers)} note="saw or clicked it" />
          <KpiCard
            label="Sessions"
            value={formatNumber(totals.sessions)}
            // A session is counted once it has ended (30 minutes without activity), so about 40 minutes after a visit.
            note={totals.sessions > 0 ? `${formatNumber(totals.convertedSessions)} converted` : 'counted about 40 min after a visit'}
          />
        </dl>
      </section>

      <div className="analytics__grid">
        <section aria-labelledby="funnel-heading" className="panel">
          <h2 id="funnel-heading" className="analytics__heading">
            Funnel
          </h2>
          <FunnelBars
            steps={[
              { label: 'Impressions', value: totals.impressions },
              { label: 'Clicks', value: totals.clicks, rate: `${formatPercent(totals.ctr)} of impressions clicked` },
              { label: 'Add-to-carts', value: totals.addToCarts, rate: `${formatPercent(totals.clickToBasket)} of clicks added to cart` },
            ]}
          />
        </section>

        <section aria-labelledby="devices-heading" className="panel" data-testid="by-client">
          <h2 id="devices-heading" className="analytics__heading">
            Web vs mobile
          </h2>
          {totals.impressions + totals.clicks + totals.uniqueCustomers === 0 ? (
            <p className="muted">No activity yet in this period.</p>
          ) : (
            <>
              <SplitBar label="Impressions" web={byClient.web.impressions} mobile={byClient.mobile.impressions} />
              <SplitBar label="Clicks" web={byClient.web.clicks} mobile={byClient.mobile.clicks} />
              <SplitBar label="Add-to-carts" web={byClient.web.addToCarts} mobile={byClient.mobile.addToCarts} />
              <SplitBar
                label="Customers"
                web={byClient.web.customers}
                mobile={byClient.mobile.customers}
                note={bothClients > 0 ? `${formatNumber(bothClients)} used both apps (counted in each)` : null}
              />
              <SplitBar label="Sessions" web={byClient.web.sessions} mobile={byClient.mobile.sessions} />
            </>
          )}
        </section>
      </div>

      <section aria-labelledby="products-heading" className="panel analytics__section">
        <h2 id="products-heading" className="analytics__heading">
          Products
        </h2>
        <div className="table-scroll">
          <table className="product-table">
            <caption className="visually-hidden">Each product’s results, most impressions first</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Product</th>
                <th scope="col" className="num">Impressions</th>
                <th scope="col" className="num">Clicks</th>
                <th scope="col">CTR</th>
                <th scope="col" className="num">Add-to-carts</th>
                <th scope="col" className="num">Click-to-basket</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const idle = item.impressions === 0 && item.clicks === 0 && item.addToCarts === 0
                return (
                  <tr key={item.productId} className={idle ? 'product-table__idle' : undefined}>
                    <td className="product-table__rank">{index + 1}</td>
                    <th scope="row">
                      <span className="product-table__name">{item.name ?? item.productId}</span>
                      {item.category ? <span className="product-table__category">{item.category}</span> : null}
                    </th>
                    <td className="num">{formatNumber(item.impressions)}</td>
                    <td className="num">{formatNumber(item.clicks)}</td>
                    <td>
                      <span className="inline-bar" aria-hidden="true">
                        <span className="inline-bar__fill" style={{ width: `${topCtr > 0 ? (item.ctr / topCtr) * 100 : 0}%` }} />
                      </span>
                      <span className="num">{formatPercent(item.ctr)}</span>
                    </td>
                    <td className="num">{formatNumber(item.addToCarts)}</td>
                    <td className="num">{formatPercent(item.clickToBasket)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {quiet > 0 ? <p className="muted small">{quiet} of {items.length} products had no activity in this period.</p> : null}
      </section>
    </>
  )
}

/** The campaign's products: take one out, or add another of the seller's. */
function ManageProducts({ campaign, act }) {
  const { user } = useAuth()
  const { products } = useCatalog()
  const [adding, setAdding] = useState('')
  const own = products.filter((product) => product.sellerId === user.sellerId)
  const name = (productId) => own.find((product) => product.id === productId)?.name ?? productId
  const notIn = own.filter((product) => !campaign.productIds.includes(product.id))
  return (
    <section aria-labelledby="manage-heading" className="panel analytics__section">
      <h2 id="manage-heading" className="analytics__heading">
        Products in this campaign
      </h2>
      <ul className="chips">
        {campaign.productIds.map((productId) => (
          <li key={productId} className="chip">
            {name(productId)}
            <Button size="sm" variant="link" onClick={() => act(() => removeCampaignProduct(campaign.id, productId))} aria-label={`Remove ${name(productId)}`}>
              ×
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
    </section>
  )
}
