import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { formatCount, formatPercent } from '../../utils/format.js'
import { METRICS } from './analyticsService.js'
import { calculateClickToBasketRate, calculateCtr } from './metricMath.js'
import { useCampaignMetrics } from './useCampaignMetrics.js'

/**
 * Side-by-side view of every campaign. Counts are deliberately not summed:
 * until the backend confirms whether these are unique customers or event
 * totals, adding them across campaigns could double count.
 */
export function CampaignComparison({ api, campaigns, period }) {
  return (
    <div className="table-wrap">
      <p className="muted small">Each campaign’s metrics load independently; cells show a spinner until their request finishes.</p>
      <table className="comparison-table">
        <caption className="visually-hidden">Metrics per campaign</caption>
        <thead>
          <tr>
            <th scope="col">Campaign</th>
            <th scope="col">Impressions</th>
            <th scope="col">Clicks</th>
            <th scope="col">Click-to-basket</th>
            <th scope="col">CTR</th>
            <th scope="col">Click-to-basket rate</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((campaign) => (
            <ComparisonRow key={campaign.id} api={api} campaign={campaign} period={period} />
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Totals across campaigns are not shown until the API confirms that counts are comparable (unique customers vs.
        event totals).
      </p>
    </div>
  )
}

function ComparisonRow({ api, campaign, period }) {
  const { metrics, retry } = useCampaignMetrics(api, campaign.id, period)
  const { clicks, impressions, clickToBasket } = metrics
  const failed = METRICS.filter((metric) => metrics[metric].status === 'error')

  return (
    <tr>
      <th scope="row">
        {campaign.title}
        <span className="muted small block">{campaign.id}</span>
        {failed.length > 0 ? (
          <Button variant="link" size="sm" onClick={() => failed.forEach(retry)}>
            Retry failed
          </Button>
        ) : null}
      </th>
      <CountCell state={impressions} />
      <CountCell state={clicks} />
      <CountCell state={clickToBasket} />
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
  return <td>{formatPercent(value)}</td>
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
  return <td>{formatCount(state.value)}</td>
}
