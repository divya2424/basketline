// DEMO DATA ONLY. Used when VITE_ANALYTICS_MODE=mock; the dashboard labels it as
// mock data. Never used as a fallback when live requests fail.
const MOCK_COUNTS = {
  campaign_001: { impressions: 12450, clicks: 1240, clickToBasket: 312, uniqueCustomers: 4870, sessions: 5600 },
  campaign_002: { impressions: 8120, clicks: 640, clickToBasket: 96, uniqueCustomers: 3310, sessions: 3900 },
  // All zeros, to demonstrate the "—" display for zero denominators.
  campaign_003: { impressions: 0, clicks: 0, clickToBasket: 0, uniqueCustomers: 0, sessions: 0 },
  campaign_004: { impressions: 4310, clicks: 205, clickToBasket: 41, uniqueCustomers: 1980, sessions: 2300 },
}

const MOCK_LATENCY_MS = 350
const DAY = 24 * 60 * 60 * 1000

/** The counts above are for 30 days; other ranges scale them by the days they cover, so the time filter visibly works. */
function rangeScale({ from, to } = {}) {
  if (!from) return 1
  const days = Math.ceil(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / DAY)
  return Math.max(days, 1) / 30
}

/** Stable made-up counts for any other campaign ID (e.g. real UUIDs from the API). */
function generatedCounts(campaignId) {
  let hash = 0
  for (const char of campaignId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const impressions = 2000 + (hash % 9000)
  const clicks = Math.round(impressions * (0.04 + (hash % 7) / 100))
  return {
    impressions,
    clicks,
    clickToBasket: Math.round(clicks * (0.1 + (hash % 5) / 20)),
    uniqueCustomers: Math.round(impressions * 0.4),
    sessions: Math.round(impressions * 0.45),
  }
}

export function getMockMetric(campaignId, metric, signal, period) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const count = Math.round((MOCK_COUNTS[campaignId] ?? generatedCounts(campaignId))[metric] * rangeScale(period))
      // About two thirds on web; a tenth of the unique customers on both apps.
      const web = Math.round(count * 0.65)
      const both = metric === 'uniqueCustomers' ? Math.round(count * 0.1) : 0
      // Events come from fewer customers than events; a sixth of the sessions convert, in about 12 minutes.
      const people = metric === 'uniqueCustomers' ? count : Math.round(count * 0.7)
      const customers = ['impressions', 'clicks', 'clickToBasket'].includes(metric) ? { customers: people } : {}
      // A quarter of the customers registered, a tenth of them seen as a visitor first.
      const registered = Math.round(people * 0.25)
      const byUserType = { registered, visitor: people - registered + Math.round(registered * 0.1) }
      const sessionStats = metric === 'sessions' ? { sessionStats: { converted: Math.round(count / 6), averageDurationMs: count ? 12 * 60_000 : 0 } } : {}
      resolve({ count, byClientType: metric === 'sessions' ? null : { web, mobile: count - web + both, ...(both ? { both } : {}) }, byUserType: metric === 'sessions' ? null : byUserType, ...customers, ...sessionStats })
    }, MOCK_LATENCY_MS)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })
}
