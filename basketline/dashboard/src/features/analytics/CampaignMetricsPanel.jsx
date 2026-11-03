import { METRICS, METRIC_LABELS } from './analyticsService.js'
import { calculateClickToBasketRate, calculateCtr } from './metricMath.js'
import { EventTotal, FunnelRate, MetricCard, SplitBar } from './MetricCard.jsx'
import { useCampaignMetrics } from './useCampaignMetrics.js'

// The funnel cards count customers, as the API's spec defines these metrics; the
// event totals are under them, and the rates between the cards are of events.
const HINTS = {
  impressions: 'Customers who saw the ad',
  clicks: 'Customers who clicked the ad',
  clickToBasket: 'Customers who added a product to their cart within 7 days of clicking it in the ad',
  uniqueCustomers: 'People who saw or clicked the ad, each counted once',
  sessions: 'Visits that saw or clicked the ad (a visit ends after 30 minutes without activity)',
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

/** Sessions that added a product they clicked in the ad to the cart, and the rest. */
function conversions(state) {
  if (state.converted == null || state.value == null) return null
  return (
    <SplitBar
      title="Added a clicked product to the cart in the same visit"
      segments={[
        { label: 'Converted', value: state.converted, tone: 'converted' },
        { label: 'Other', value: Math.max(state.value - state.converted, 0), tone: 'browsed' },
      ]}
    />
  )
}

/**
 * One campaign's metrics as a funnel (impressions → clicks → click-to-basket,
 * with the conversion rate between each step) and its audience (unique
 * customers and sessions), in one store (storeId) or all.
 */
export function CampaignMetricsPanel({ api, campaignId, storeId, period }) {
  const { metrics, retry } = useCampaignMetrics(api, campaignId, period, storeId)
  const { clicks, impressions, clickToBasket, uniqueCustomers, sessions } = metrics
  const pendingCount = METRICS.filter((metric) => metrics[metric].status === 'loading').length
  const card = (metric, children, tone, value) => (
    <MetricCard label={METRIC_LABELS[metric]} hint={HINTS[metric]} state={metrics[metric]} value={value} onRetry={() => retry(metric)} tone={tone}>
      {children}
    </MetricCard>
  )
  // A funnel step: its customers first (the event count if a response has none), then its events.
  const funnelCard = (metric, noun, tone) => {
    const state = metrics[metric]
    const hasCustomers = state.customers != null
    return card(
      metric,
      <>
        {hasCustomers ? <EventTotal value={state.value} noun={noun} /> : null}
        {platform(state, 'Events by platform')}
        {userTypes(state)}
      </>,
      tone,
      hasCustomers ? state.customers : state.value,
    )
  }

  return (
    <div className="metrics-panel">
      <div className="section-head">
        <h2 className="section-head__title">Ad funnel</h2>
        <div className="section-head__status" aria-live="polite">
          {pendingCount > 0 ? (
            <p className="loading-chip" data-testid="metrics-loading">
              <span className="loading-chip__dot" aria-hidden="true" />
              Loading metrics for {campaignId}… ({METRICS.length - pendingCount} of {METRICS.length} loaded)
            </p>
          ) : null}
        </div>
      </div>
      <div className="funnel">
        {funnelCard('impressions', 'impressions', 'step1')}
        <FunnelRate
          label="Click-through rate (CTR)"
          short="click-through"
          formula="Click events ÷ impression events × 100"
          value={calculateCtr(clicks.value, impressions.value)}
          loading={clicks.status === 'loading' || impressions.status === 'loading'}
        />
        {funnelCard('clicks', 'clicks', 'step2')}
        <FunnelRate
          label="Click-to-basket rate"
          short="add to cart"
          formula="Credited basket additions ÷ click events × 100"
          value={calculateClickToBasketRate(clickToBasket.value, clicks.value)}
          loading={clicks.status === 'loading' || clickToBasket.status === 'loading'}
        />
        {funnelCard('clickToBasket', 'basket additions', 'step3')}
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
          <>
            {conversions(sessions)}
            {platform(sessions, 'Visits with events from')}
          </>,
        )}
      </div>
    </div>
  )
}
