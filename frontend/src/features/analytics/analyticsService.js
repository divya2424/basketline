/**
 * Campaign analytics API client. All network access for the dashboard lives
 * here; components never call fetch directly.
 *
 *   GET {VITE_API_BASE_URL}/ad/{campaignID}/clicks?from&to
 *   GET {VITE_API_BASE_URL}/ad/{campaignID}/impressions?from&to
 *   GET {VITE_API_BASE_URL}/ad/{campaignID}/clickToBasket?from&to
 *
 * from/to are ISO timestamps (see timeRange.js); without them the backend
 * counts the last 30 days.
 *
 * The response contract is not confirmed yet. parseMetricResponse() is the only
 * place that knows the response shape: change it when the backend is final.
 */
import { getMockMetric } from './mockMetrics.js'
import { apiRequest } from '../../api/httpClient.js'

export const METRICS = ['clicks', 'impressions', 'clickToBasket']

export const METRIC_LABELS = {
  clicks: 'Ad clicks',
  impressions: 'Ad impressions',
  clickToBasket: 'Click-to-basket',
}

export class MetricRequestError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause })
    this.name = 'MetricRequestError'
    this.status = status
  }
}

export function buildMetricUrl(baseUrl, campaignId, metric, { from, to } = {}) {
  if (!METRICS.includes(metric)) throw new Error(`Unknown metric "${metric}"`)
  const base = (baseUrl ?? '').replace(/\/+$/, '')
  const query = new URLSearchParams(Object.entries({ from, to }).filter(([, value]) => value)).toString()
  return `${base}/ad/${encodeURIComponent(campaignId)}/${metric}${query ? `?${query}` : ''}`
}

function toCount(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null
}

/**
 * Response adapter. Accepts a bare number (`1240`, or "1240" as text) or an
 * object with a numeric `count` (`{ "count": 1240 }`). Anything else is an error,
 * never a guessed value.
 */
export function parseMetricResponse(body) {
  const count = toCount(body) ?? (body !== null && typeof body === 'object' ? toCount(body.count) : null)
  if (count === null) throw new MetricRequestError('Unexpected response format')
  return count
}

export function createAnalyticsApi({ mode = 'live', baseUrl = '' } = {}) {
  if (mode === 'mock') {
    return {
      mode,
      baseUrl: null,
      fetchMetric: (campaignId, metric, { signal, from, to } = {}) => getMockMetric(campaignId, metric, signal, { from, to }),
    }
  }

  return {
    mode: 'live',
    baseUrl,
    // Through apiRequest: sends the access token, and a 401 signs the user out.
    async fetchMetric(campaignId, metric, { signal, from, to } = {}) {
      const url = buildMetricUrl('', campaignId, metric, { from, to })
      const body = await apiRequest(url, { signal, baseUrl: baseUrl.replace(/\/+$/, '') })
      return parseMetricResponse(body)
    },
  }
}

export const analyticsApi = createAnalyticsApi({
  mode: import.meta.env.VITE_ANALYTICS_MODE === 'mock' ? 'mock' : 'live',
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
})
