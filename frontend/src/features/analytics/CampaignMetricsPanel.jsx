import { formatPercent } from '../../utils/format.js'
import { Spinner } from '../../components/common/Spinner.jsx'
import { METRICS, METRIC_LABELS } from './analyticsService.js'
import { calculateClickToBasketRate, calculateCtr } from './metricMath.js'
import { MetricCard, RateCard } from './MetricCard.jsx'
import { useCampaignMetrics } from './useCampaignMetrics.js'

const DESCRIPTIONS = {
  clicks: 'Clicks on the campaign ad',
  impressions: 'Times the campaign ad was viewed',
  clickToBasket: 'Cart additions after an ad click',
}

export function CampaignMetricsPanel({ api, campaignId, campaignTitle, period }) {
  const { metrics, retry } = useCampaignMetrics(api, campaignId, period)
  const { clicks, impressions, clickToBasket } = metrics

  const ctr = calculateCtr(clicks.value, impressions.value)
  const basketRate = calculateClickToBasketRate(clickToBasket.value, clicks.value)
  const pendingCount = METRICS.filter((metric) => metrics[metric].status === 'loading').length

  return (
    <>
      <div className="loading-banner-slot" aria-live="polite">
        {pendingCount > 0 ? (
          <p className="loading-banner" data-testid="metrics-loading">
            <Spinner size="sm" />
            Loading metrics for {campaignTitle ?? campaignId}… ({METRICS.length - pendingCount} of {METRICS.length} loaded)
          </p>
        ) : null}
      </div>
      <div className="metrics-grid">
      {['impressions', 'clicks', 'clickToBasket'].map((metric) => (
        <MetricCard
          key={metric}
          label={METRIC_LABELS[metric]}
          description={DESCRIPTIONS[metric]}
          state={metrics[metric]}
          onRetry={() => retry(metric)}
        />
      ))}
      <RateCard
        label="Click-through rate (CTR)"
        formula="Clicks ÷ impressions × 100"
        value={formatPercent(ctr)}
        loading={clicks.status === 'loading' || impressions.status === 'loading'}
      />
      <RateCard
        label="Click-to-basket rate"
        formula="Click-to-basket ÷ clicks × 100"
        value={formatPercent(basketRate)}
        loading={clicks.status === 'loading' || clickToBasket.status === 'loading'}
      />
      </div>
    </>
  )
}
