/**
 * Campaign analytics API client. All network access for the dashboard lives
 * here; components never call fetch directly.
 *
 *   GET {VITE_API_BASE_URL}/ad/{campaignID}/clicks?from&to
 *   GET {VITE_API_BASE_URL}/ad/{campaignID}/impressions?from&to
 *   GET {VITE_API_BASE_URL}/ad/{campaignID}/clickToBasket?from&to
 *   GET {VITE_API_BASE_URL}/ad/{campaignID}/uniqueCustomers?from&to
 *   GET {VITE_API_BASE_URL}/ad/{campaignID}/sessions?from&to
 *
 * from/to are ISO timestamps (see timeRange.js); without them the backend
 * counts the last 30 days. Each answer has the total (count) and the metric's
 * columns per client type, e.g. total_web_clicks and total_mobile_clicks.
 * Impressions, clicks and click-to-basket also have the customers behind them
 * (customers), per user type e.g. customers_registered_clicks; unique customers
 * have has_visited_in_web, has_visited_in_mobile and has_visited_in_both, and per
 * user type has_visited_registered and has_visited_visitor; sessions have
 * total_converted_sessions and avg_session_duration_ms.
 *
 * The response contract is not confirmed yet. parseMetricResponse() is the only
 * place that knows the response shape: change it when the backend is final.
 */
import { getMockMetric } from './mockMetrics.js'
import { apiRequest } from '../../api/httpClient.js'

export const METRICS = ['clicks', 'impressions', 'clickToBasket', 'uniqueCustomers', 'sessions']

/** The response field of each metric's count per client type (unique customers also on both). */
const CLIENT_FIELDS = {
  clicks: { web: 'total_web_clicks', mobile: 'total_mobile_clicks' },
  impressions: { web: 'total_web_impressions', mobile: 'total_mobile_impressions' },
  clickToBasket: { web: 'total_web_click_to_basket', mobile: 'total_mobile_click_to_basket' },
  uniqueCustomers: { web: 'has_visited_in_web', mobile: 'has_visited_in_mobile', both: 'has_visited_in_both' },
}

/** Customers per user type: people seen as registered users, and as visitors (one can be both). */
const USER_FIELDS = {
  clicks: { registered: 'customers_registered_clicks', visitor: 'customers_visitor_clicks' },
  impressions: { registered: 'customers_registered_impressions', visitor: 'customers_visitor_impressions' },
  clickToBasket: { registered: 'customers_registered_click_to_basket', visitor: 'customers_visitor_click_to_basket' },
  uniqueCustomers: { registered: 'has_visited_registered', visitor: 'has_visited_visitor' },
}

/** Sessions that saw the campaign: those that converted, and their average duration. */
const SESSION_FIELDS = { converted: 'total_converted_sessions', averageDurationMs: 'avg_session_duration_ms' }

export const METRIC_LABELS = {
  clicks: 'Ad clicks',
  impressions: 'Ad impressions',
  clickToBasket: 'Click-to-basket',
  uniqueCustomers: 'Unique customers',
  sessions: 'Sessions',
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

/** The fields' counts by key, or null unless every one is a count. */
function counts(body, fields = {}) {
  const split = Object.entries(fields).map(([key, field]) => [key, toCount(body !== null && typeof body === 'object' ? body[field] : null)])
  return split.length > 0 && split.every(([, value]) => value !== null) ? Object.fromEntries(split) : null
}

/**
 * Response adapter: { count, byClientType: { web, mobile[, both] }, byUserType:
 * { registered, visitor } (customers), plus customers (impressions, clicks and
 * click-to-basket) or sessionStats: { converted, averageDurationMs } (sessions)
 * when the response has them }. Accepts a bare number (`1240`, or "1240" as
 * text) or an object with a numeric `count` (`{ "count": 1240 }`), with the
 * metric's columns when all of them are counts (else that split is null or
 * left out). Anything else is an error, never a guessed value.
 */
export function parseMetricResponse(body, metric) {
  const isObject = body !== null && typeof body === 'object'
  const count = toCount(body) ?? (isObject ? toCount(body.count) : null)
  if (count === null) throw new MetricRequestError('Unexpected response format')
  const customers = isObject ? toCount(body.customers) : null
  const sessionStats = metric === 'sessions' ? counts(body, SESSION_FIELDS) : null
  return {
    count,
    byClientType: counts(body, CLIENT_FIELDS[metric]),
    byUserType: counts(body, USER_FIELDS[metric]),
    ...(customers === null ? {} : { customers }),
    ...(sessionStats === null ? {} : { sessionStats }),
  }
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
      return parseMetricResponse(body, metric)
    },
  }
}

export const analyticsApi = createAnalyticsApi({
  mode: import.meta.env.VITE_ANALYTICS_MODE === 'mock' ? 'mock' : 'live',
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
})
