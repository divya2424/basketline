// DEMO DATA ONLY. Used when VITE_ANALYTICS_MODE=mock; the dashboard labels it as
// mock data. Never used as a fallback when live requests fail.
const MOCK_COUNTS = {
  campaign_001: { impressions: 12450, clicks: 1240, clickToBasket: 312 },
  campaign_002: { impressions: 8120, clicks: 640, clickToBasket: 96 },
  // All zeros, to demonstrate the "—" display for zero denominators.
  campaign_003: { impressions: 0, clicks: 0, clickToBasket: 0 },
  campaign_004: { impressions: 4310, clicks: 205, clickToBasket: 41 },
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
  return { impressions, clicks, clickToBasket: Math.round(clicks * (0.1 + (hash % 5) / 20)) }
}

export function getMockMetric(campaignId, metric, signal, period) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(Math.round((MOCK_COUNTS[campaignId] ?? generatedCounts(campaignId))[metric] * rangeScale(period)))
    }, MOCK_LATENCY_MS)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })
}
