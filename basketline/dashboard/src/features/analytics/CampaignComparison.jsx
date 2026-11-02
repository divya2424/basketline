import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { formatCount, formatPercent } from '../../utils/format.js'
import { METRICS } from './analyticsService.js'
import { calculateClickToBasketRate, calculateCtr } from './metricMath.js'
import { useCampaignMetrics } from './useCampaignMetrics.js'

/**
 * Side-by-side view of every campaign: each count with the customers behind it,
 * and the two conversion rates. There is no totals row: one shopper can see
 * several campaigns, so customers can't be added across them. In one store
 * (storeId) or all.
 */
export function CampaignComparison({ api, campaigns, storeId, period }) {
  return (
    <div className="table-wrap">
      <table className="comparison-table">
        <caption className="visually-hidden">Metrics per campaign</caption>
        <thead>
          <tr>
            <th scope="col">Campaign</th>
            <th scope="col">Impressions</th>
            <th scope="col">Clicks</th>
            <th scope="col">Click-to-basket</th>
            <th scope="col">Unique customers</th>
            <th scope="col">CTR</th>
            <th scope="col">Click-to-basket rate</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((campaign) => (
            <ComparisonRow key={campaign.id} api={api} campaign={campaign} storeId={storeId} period={period} />
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Events, with the customers behind them underneath. No totals: a shopper who saw several campaigns would be counted
        once per campaign.
      </p>
    </div>
  )
}

function ComparisonRow({ api, campaign, storeId, period }) {
  const { metrics, retry } = useCampaignMetrics(api, campaign.id, period, storeId)
  const { clicks, impressions, clickToBasket, uniqueCustomers } = metrics
  const failed = METRICS.filter((metric) => metrics[metric].status === 'error')

  return (
    <tr>
      <th scope="row">
        <span className="comparison-table__id">{campaign.id}</span>
        {failed.length > 0 ? (
          <Button variant="link" size="sm" onClick={() => failed.forEach(retry)}>
            Retry failed
          </Button>
        ) : null}
      </th>
      <CountCell state={impressions} />
      <CountCell state={clicks} />
      <CountCell state={clickToBasket} />
      <CountCell state={uniqueCustomers} />
      <RateCell inputs={[clicks, impressions]} value={calculateCtr(clicks.value, impressions.value)} />
      <RateCell inputs={[clickToBasket, clicks]} value={calculateClickToBasketRate(clickToBasket.value, clicks.value)} />
    </tr>
  )
}

// A rate is still loading while either of its counts is.
function RateCell({ inputs, value }) {
  if (inputs.some((state) => state.status === 'loading')) {
    return (
      <td aria-busy="true">
        <Spinner size="sm" label="Calculating" />
      </td>
    )
  }
  return (
    <td>
      <span className={`rate-pill${value === null ? ' rate-pill--empty' : ''}`}>{formatPercent(value)}</span>
    </td>
  )
}

function CountCell({ state }) {
  if (state.status === 'loading') {
    return (
      <td aria-busy="true">
        <Spinner size="sm" label="Loading" />
      </td>
    )
  }
  if (state.status === 'error') return <td className="cell-error">Unavailable</td>
  return (
    <td>
      {formatCount(state.value)}
      {state.customers != null ? <span className="comparison-table__sub">{formatCount(state.customers)} customers</span> : null}
    </td>
  )
}
