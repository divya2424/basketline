import { useEffect, useState } from 'react'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { formatCount, formatPercent } from '../../utils/format.js'

/**
 * A campaign's results per product, in one store (storeId) or all: what a seller
 * sees for the products it put in the campaign. Products without activity in the
 * period aren't listed; a product never named shows its ID.
 */
export function ProductResults({ api, campaignId, storeId, period: { from, to } = {} }) {
  const [state, setState] = useState({ status: 'loading', items: [] })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading', items: [] })
    api.fetchProducts(campaignId, { signal: controller.signal, from, to, storeId }).then(
      (items) => setState({ status: 'success', items }),
      (error) => !controller.signal.aborted && setState({ status: 'error', items: [], error: error?.message || 'Request failed' }),
    )
    return () => controller.abort()
  }, [api, campaignId, from, to, storeId, attempt])

  if (state.status === 'loading') return <Spinner size="sm" label="Loading products" />
  if (state.status === 'error') {
    return (
      <p role="alert">
        Couldn’t load the products: {state.error}{' '}
        <Button variant="link" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </Button>
      </p>
    )
  }
  if (state.items.length === 0) return <p className="muted">No product had impressions or clicks in this period.</p>
  return (
    <div className="table-wrap">
      <table className="comparison-table" data-testid="product-results">
        <caption className="visually-hidden">Results per product</caption>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Impressions</th>
            <th scope="col">Clicks</th>
            <th scope="col">CTR</th>
            <th scope="col">Add-to-carts</th>
            <th scope="col">Click-to-basket rate</th>
          </tr>
        </thead>
        <tbody>
          {state.items.map((item) => (
            <tr key={item.productId}>
              <th scope="row">{item.name ?? <span className="comparison-table__id">{item.productId}</span>}</th>
              <td>{formatCount(item.impressions)}</td>
              <td>{formatCount(item.clicks)}</td>
              <td>{formatPercent(item.impressions > 0 ? item.ctr * 100 : null)}</td>
              <td>{formatCount(item.addToCarts)}</td>
              <td>{formatPercent(item.clicks > 0 ? item.clickToBasket * 100 : null)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
