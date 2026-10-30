import { formatDuration } from '../../utils/format.js'
import { METRICS, METRIC_LABELS } from './analyticsService.js'
import { calculateClickToBasketRate, calculateCtr } from './metricMath.js'
import { Customers, FunnelRate, MetricCard, ProgressStat, SplitBar } from './MetricCard.jsx'
import { useCampaignMetrics } from './useCampaignMetrics.js'

const HINTS = {
  impressions: 'Times the ad was seen',
  clicks: 'Clicks on the ad',
  clickToBasket: 'Added to cart within 7 days of clicking that product in the ad',
  uniqueCustomers: 'People who saw or clicked the ad, each counted once',
  sessions: 'Visits that saw the ad; a visit ends after 6 hours without activity',
}

/** Web and mobile, as a split bar (unique customers: web only, both, mobile only). */
function platform(state, title) {
  const split = state.byClientType
  if (!split) return null
  const segments =
    split.both !== undefined
      ? [
          { label: 'Web only', value: Math.max(split.web - split.both, 0), tone: 'web' },
          { label: 'Both', value: split.both, tone: 'both' },
          { label: 'Mobile only', value: Math.max(split.mobile - split.both, 0), tone: 'mobile' },
        ]
      : [
          { label: 'Web', value: split.web, tone: 'web' },
          { label: 'Mobile', value: split.mobile, tone: 'mobile' },
        ]
  return <SplitBar title={title} segments={segments} />
}

/** Registered users and visitors, as a split bar; someone seen as both counts in each. */
function userTypes(state) {
  const split = state.byUserType
  if (!split) return null
  return (
    <SplitBar
      title="Customers by type"
      segments={[
        { label: 'Registered', value: split.registered, tone: 'registered' },
        { label: 'Visitors', value: split.visitor, tone: 'visitor' },
      ]}
    />
  )
}

/**
 * One campaign's metrics as a funnel (impressions → clicks → click-to-basket,
 * with the conversion rate between each step) and its audience (unique
 * customers, sessions).
 */
export function CampaignMetricsPanel({ api, campaignId, campaignTitle, period }) {
  const { metrics, retry } = useCampaignMetrics(api, campaignId, period)
  const { clicks, impressions, clickToBasket, uniqueCustomers, sessions } = metrics
  const pendingCount = METRICS.filter((metric) => metrics[metric].status === 'loading').length
  const card = (metric, children, tone) => (
    <MetricCard label={METRIC_LABELS[metric]} hint={HINTS[metric]} state={metrics[metric]} onRetry={() => retry(metric)} tone={tone}>
      {children}
    </MetricCard>
  )
  const eventDetails = (state) => (
    <>
      <Customers value={state.customers} />
      {platform(state, 'By platform')}
      {userTypes(state)}
    </>
  )

  return (
    <div className="metrics-panel">
      <div className="section-head">
        <h2 className="section-head__title">Ad funnel</h2>
        <div className="section-head__status" aria-live="polite">
          {pendingCount > 0 ? (
            <p className="loading-chip" data-testid="metrics-loading">
              <span className="loading-chip__dot" aria-hidden="true" />
              Loading metrics for {campaignTitle ?? campaignId}… ({METRICS.length - pendingCount} of {METRICS.length} loaded)
            </p>
          ) : null}
        </div>
      </div>
      <div className="funnel">
        {card('impressions', eventDetails(impressions), 'step1')}
        <FunnelRate
          label="Click-through rate (CTR)"
          short="click-through"
          formula="Clicks ÷ impressions × 100"
          value={calculateCtr(clicks.value, impressions.value)}
          loading={clicks.status === 'loading' || impressions.status === 'loading'}
        />
        {card('clicks', eventDetails(clicks), 'step2')}
        <FunnelRate
          label="Click-to-basket rate"
          short="add to cart"
          formula="Click-to-basket ÷ clicks × 100"
          value={calculateClickToBasketRate(clickToBasket.value, clicks.value)}
          loading={clicks.status === 'loading' || clickToBasket.status === 'loading'}
        />
        {card('clickToBasket', eventDetails(clickToBasket), 'step3')}
      </div>

      <div className="section-head">
        <h2 className="section-head__title">Audience</h2>
      </div>
      <div className="audience">
        {card(
          'uniqueCustomers',
          <>
            {platform(uniqueCustomers, 'Where they came from')}
            {userTypes(uniqueCustomers)}
          </>,
        )}
        {card(
          'sessions',
          sessions.sessionStats ? (
            <>
              <ProgressStat label="Converted" value={sessions.sessionStats.converted} of={sessions.value} />
              <p className="metric-card__fact">
                Average visit <strong>{formatDuration(sessions.sessionStats.averageDurationMs)}</strong>
              </p>
              <p className="metric-card__note">Updated about 7 hours after a visit ends</p>
            </>
          ) : null,
        )}
      </div>
    </div>
  )
}
