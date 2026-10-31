import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnalyticsPage } from './AnalyticsPage.jsx'
import { buildMetricUrl, createAnalyticsApi, parseMetricResponse } from './analyticsService.js'
import { calculateClickToBasketRate, calculateCtr } from './metricMath.js'
import { campaigns } from '../campaigns/campaignData.js'
import { mockFetch } from '../../test/mockFetch.js'
import { DEFAULT_TIME_RANGE, formatRangeLabel, toPeriod } from './timeRange.js'
import { REFRESH_MS } from './useCampaignMetrics.js'
import { AuthProvider } from '../auth/AuthContext.jsx'
import { MANAGER } from '../../test/utils.jsx'

/** The dashboard as a campaign manager sees it. */
const AsManager = ({ children }) => <AuthProvider persist={false} initialUser={MANAGER}>{children}</AuthProvider>

/** Fake API whose requests are settled manually from the test. */
function createDeferredApi(mode = 'live') {
  const pending = []
  const api = {
    mode,
    baseUrl: 'https://api.test',
    fetchMetric: vi.fn(
      (campaignId, metric, period) =>
        new Promise((resolve, reject) => {
          pending.push({ campaignId, metric, period, resolve, reject })
        }),
    ),
  }
  /** Settles the latest matching request, or the one for `period` when given. */
  const settle = async (campaignId, metric, outcome, period) => {
    const request = pending.findLast(
      (r) => r.campaignId === campaignId && r.metric === metric && (!period || r.period.from === period.from),
    )
    await act(async () => {
      if (outcome instanceof Error) request.reject(outcome)
      // A count, or { count, byClientType } as the API client returns it.
      else request.resolve(typeof outcome === 'number' ? { count: outcome, byClientType: null } : outcome)
    })
  }
  const resolveAll = async (campaignId, values) => {
    for (const [metric, value] of Object.entries(values)) await settle(campaignId, metric, value)
  }
  return { api, settle, resolveAll }
}

const card = (label) => screen.getByRole('heading', { name: label }).closest('article')

describe('analyticsService', () => {
  it('builds the three endpoint URLs and encodes campaign IDs', () => {
    expect(buildMetricUrl('https://api.test/', 'campaign_001', 'clicks')).toBe('https://api.test/ad/campaign_001/clicks')
    expect(buildMetricUrl('', 'campaign_001', 'impressions')).toBe('/ad/campaign_001/impressions')
    expect(buildMetricUrl('https://api.test', 'a/b c?', 'clickToBasket')).toBe('https://api.test/ad/a%2Fb%20c%3F/clickToBasket')
  })

  it('adds the period as from/to query parameters, leaving out an open end', () => {
    expect(buildMetricUrl('', 'c1', 'clicks', { from: '2026-10-22T00:00:00.000Z' })).toBe(
      '/ad/c1/clicks?from=2026-10-22T00%3A00%3A00.000Z',
    )
    expect(buildMetricUrl('', 'c1', 'clicks', { from: '2026-10-01T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z' })).toBe(
      '/ad/c1/clicks?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-11T00%3A00%3A00.000Z',
    )
  })

  it('parses numeric and { count } responses, and rejects anything else', () => {
    expect(parseMetricResponse(1240, 'clicks')).toEqual({ count: 1240, byClientType: null, byUserType: null })
    expect(parseMetricResponse('1240', 'clicks')).toEqual({ count: 1240, byClientType: null, byUserType: null })
    expect(parseMetricResponse({ count: 0 }, 'clicks')).toEqual({ count: 0, byClientType: null, byUserType: null })
    expect(parseMetricResponse({ count: 5, total_clicks: 5, total_web_clicks: 3, total_mobile_clicks: 2 }, 'clicks')).toEqual({
      count: 5,
      byClientType: { web: 3, mobile: 2 },
      byUserType: null,
    })
    const customers = { has_visited: 4, has_visited_in_web: 3, has_visited_in_mobile: 2, has_visited_in_both: 1, has_visited_registered: 3, has_visited_visitor: 2 }
    expect(parseMetricResponse({ count: 4, ...customers }, 'uniqueCustomers')).toEqual({
      count: 4,
      byClientType: { web: 3, mobile: 2, both: 1 },
      byUserType: { registered: 3, visitor: 2 },
    })
    expect(parseMetricResponse({ count: 5, total_web_clicks: 3 }, 'clicks')).toEqual({ count: 5, byClientType: null, byUserType: null })
    expect(() => parseMetricResponse({ total: 5 })).toThrow('Unexpected response format')
    expect(() => parseMetricResponse(-1)).toThrow('Unexpected response format')
    expect(() => parseMetricResponse('')).toThrow('Unexpected response format')
  })

  it('calls fetch with the right URL and reports HTTP errors', async () => {
    const { requests, restore } = mockFetch(({ path }) =>
      path.endsWith('/clicks') ? new Response('{"count": 42}', { status: 200 }) : new Response('nope', { status: 503 }),
    )
    const api = createAnalyticsApi({ baseUrl: 'https://api.test' })
    await expect(api.fetchMetric('campaign_001', 'clicks')).resolves.toEqual({ count: 42, byClientType: null, byUserType: null })
    expect(requests[0].url).toBe('https://api.test/ad/campaign_001/clicks')
    await expect(api.fetchMetric('campaign_001', 'impressions')).rejects.toThrow('Request failed with status 503')
    restore()
  })
})

describe('rate calculations', () => {
  it('derives rates from counts and returns null for zero denominators', () => {
    expect(calculateCtr(1240, 12450)).toBeCloseTo(9.9598, 3)
    expect(calculateClickToBasketRate(312, 1240)).toBeCloseTo(25.1613, 3)
    expect(calculateCtr(0, 0)).toBeNull()
    expect(calculateClickToBasketRate(5, 0)).toBeNull()
    expect(calculateCtr(null, 100)).toBeNull()
  })
})

describe('AnalyticsPage', () => {
  it('requests every metric for the selected campaign and shows counts and rates', async () => {
    const { api, resolveAll } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })

    expect(screen.getByRole('heading', { name: 'Campaign Analytics' })).toBeInTheDocument()
    const requested = api.fetchMetric.mock.calls.map(([id, metric]) => `${id}/${metric}`)
    expect(new Set(requested)).toEqual(
      new Set(['campaign_001/clicks', 'campaign_001/impressions', 'campaign_001/clickToBasket', 'campaign_001/uniqueCustomers', 'campaign_001/sessions']),
    )
    expect(card('Ad clicks')).toHaveAttribute('aria-busy', 'true')

    await resolveAll('campaign_001', {
      impressions: 12450,
      clicks: { count: 1240, byClientType: { web: 1000, mobile: 240 } },
      clickToBasket: { count: 312, customers: 280, byUserType: { registered: 200, visitor: 90 } },
      uniqueCustomers: { count: 4870, byClientType: { web: 3000, mobile: 2200, both: 330 }, byUserType: { registered: 1200, visitor: 3900 } },
      sessions: { count: 5600, sessionStats: { converted: 900, averageDurationMs: 12 * 60_000 } },
    })
    expect(card('Ad impressions')).toHaveTextContent('12,450')
    expect(card('Unique customers')).toHaveTextContent('4,870')
    expect(card('Ad clicks')).toHaveTextContent(/By platform\s*Web 1,000\s*Mobile 240/)
    expect(card('Ad impressions')).not.toHaveTextContent('Web')
    // Web only, both, mobile only: 3,000 − 330 and 2,200 − 330.
    expect(card('Unique customers')).toHaveTextContent(/Web only 2,670\s*Both 330\s*Mobile only 1,870/)
    expect(card('Unique customers')).toHaveTextContent(/Registered 1,200\s*Visitors 3,900/)
    expect(card('Ad clicks')).toHaveTextContent('1,240')
    expect(card('Click-to-basket')).toHaveTextContent('312')
    expect(card('Click-to-basket')).toHaveTextContent('280 customers')
    expect(card('Click-to-basket')).toHaveTextContent(/Registered 200\s*Visitors 90/)
    expect(card('Ad impressions')).not.toHaveTextContent('customers')
    expect(card('Sessions')).toHaveTextContent('5,600')
    // 900 of 5,600 sessions converted.
    expect(card('Sessions')).toHaveTextContent(/Converted 900\s*· 16.07%/)
    expect(card('Sessions')).toHaveTextContent('Average visit 12 min')
    expect(card('Click-through rate (CTR)')).toHaveTextContent('9.96%')
    expect(card('Click-to-basket rate')).toHaveTextContent('25.16%')
  })

  it('shows a loader while requests are in flight and removes it when all finish', async () => {
    const { api, settle } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
    expect(screen.getByTestId('metrics-loading')).toHaveTextContent('Loading metrics for Featured Picks… (0 of 5 loaded)')
    expect(within(card('Ad clicks')).getByRole('status')).toHaveTextContent('Loading Ad clicks')

    await settle('campaign_001', 'clicks', 10)
    expect(screen.getByTestId('metrics-loading')).toHaveTextContent('(1 of 5 loaded)')
    expect(within(card('Ad clicks')).queryByRole('status')).not.toBeInTheDocument()

    await settle('campaign_001', 'impressions', 100)
    await settle('campaign_001', 'clickToBasket', new Error('boom'))
    await settle('campaign_001', 'uniqueCustomers', 7)
    await settle('campaign_001', 'sessions', 3)
    expect(screen.queryByTestId('metrics-loading')).not.toBeInTheDocument()
  })

  it('shows the loader again while a failed metric is retried', async () => {
    const { api, settle, resolveAll } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
    await resolveAll('campaign_001', { impressions: 1, clickToBasket: 1, uniqueCustomers: 1, sessions: 1 })
    await settle('campaign_001', 'clicks', new Error('Request failed with status 500'))
    expect(screen.queryByTestId('metrics-loading')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry Ad clicks' }))
    expect(screen.getByTestId('metrics-loading')).toHaveTextContent('(4 of 5 loaded)')
  })

  it('renders zero counts and shows — for zero denominators', async () => {
    const { api, resolveAll } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
    await resolveAll('campaign_001', { impressions: 0, clicks: 0, clickToBasket: 0 })
    expect(card('Ad clicks')).toHaveTextContent('0')
    expect(card('Click-through rate (CTR)')).toHaveTextContent('—')
    expect(card('Click-to-basket rate')).toHaveTextContent('—')
    expect(document.body).not.toHaveTextContent(/NaN|Infinity/)
  })

  it('keeps successful metrics visible when one endpoint fails, and retries just that one', async () => {
    const { api, settle } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
    await settle('campaign_001', 'impressions', 1000)
    await settle('campaign_001', 'clicks', new Error('Request failed with status 500'))
    await settle('campaign_001', 'clickToBasket', 25)

    expect(card('Ad impressions')).toHaveTextContent('1,000')
    expect(card('Click-to-basket')).toHaveTextContent('25')
    expect(within(card('Ad clicks')).getByRole('alert')).toHaveTextContent('Request failed with status 500')
    expect(card('Click-through rate (CTR)')).toHaveTextContent('—')

    const callsBefore = api.fetchMetric.mock.calls.length
    await userEvent.click(screen.getByRole('button', { name: 'Retry Ad clicks' }))
    expect(api.fetchMetric.mock.calls.slice(callsBefore)).toEqual([['campaign_001', 'clicks', toPeriod(DEFAULT_TIME_RANGE)]])
    expect(card('Ad clicks')).toHaveAttribute('aria-busy', 'true')
    await settle('campaign_001', 'clicks', 50)
    expect(card('Ad clicks')).toHaveTextContent('50')
    expect(card('Click-through rate (CTR)')).toHaveTextContent('5.00%')
  })

  it('refreshes on campaign change and ignores stale responses from the previous campaign', async () => {
    const { api, resolveAll } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
    await userEvent.selectOptions(screen.getByLabelText('Campaign'), 'campaign_002')

    expect(api.fetchMetric.mock.calls.some(([id]) => id === 'campaign_002')).toBe(true)
    // The slow campaign_001 responses arrive after the switch...
    await resolveAll('campaign_001', { impressions: 999, clicks: 999, clickToBasket: 999 })
    expect(card('Ad clicks')).toHaveAttribute('aria-busy', 'true')
    expect(document.body).not.toHaveTextContent('999')

    await resolveAll('campaign_002', { impressions: 8120, clicks: 640, clickToBasket: 96 })
    expect(card('Ad clicks')).toHaveTextContent('640')
    expect(card('Click-to-basket rate')).toHaveTextContent('15.00%')
  })

  it('fetches the counts again every 20 s while the page is visible, keeping what is shown until then', async () => {
    vi.useFakeTimers()
    try {
      const { api, settle, resolveAll } = createDeferredApi()
      render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
      await resolveAll('campaign_001', { impressions: 12450, clicks: 1240, clickToBasket: 312 })
      const calls = api.fetchMetric.mock.calls.length

      act(() => vi.advanceTimersByTime(REFRESH_MS))
      expect(api.fetchMetric.mock.calls.length).toBe(calls + 3)
      // No loader for a refresh: the last counts stay until the new ones arrive.
      expect(card('Ad clicks')).toHaveTextContent('1,240')
      expect(card('Ad clicks')).not.toHaveAttribute('aria-busy', 'true')

      await settle('campaign_001', 'impressions', 12500)
      await settle('campaign_001', 'clicks', new Error('Request failed with status 503'))
      expect(card('Ad impressions')).toHaveTextContent('12,500')
      // A failed refresh keeps the shown count; the next refresh tries again.
      expect(card('Ad clicks')).toHaveTextContent('1,240')

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      act(() => vi.advanceTimersByTime(REFRESH_MS))
      expect(api.fetchMetric.mock.calls.length).toBe(calls + 3)
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      vi.useRealTimers()
    }
  })

  it('compares all campaigns side by side without summing counts', async () => {
    const { api, resolveAll } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
    await userEvent.selectOptions(screen.getByLabelText('Campaign'), 'all')
    await resolveAll('campaign_001', { impressions: 100, clicks: 10, clickToBasket: 5 })
    await resolveAll('campaign_002', { impressions: 200, clicks: 20, clickToBasket: 2 })
    await resolveAll('campaign_003', { impressions: 0, clicks: 0, clickToBasket: 0 })

    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(campaigns.length)
    expect(rows[0]).toHaveTextContent('10.00%')
    expect(rows[0]).toHaveTextContent('50.00%')
    expect(rows[2]).toHaveTextContent('—')
    expect(screen.getByText(/No totals: a shopper who saw several campaigns/)).toBeInTheDocument()
  })

  it('labels the data source clearly in live and mock mode', () => {
    const { unmount } = render(<AnalyticsPage campaigns={campaigns} api={createDeferredApi('live').api} />, { wrapper: AsManager })
    expect(screen.getByTestId('data-source')).toHaveTextContent('Live API')
    unmount()
    render(<AnalyticsPage campaigns={campaigns} api={createAnalyticsApi({ mode: 'mock' })} />, { wrapper: AsManager })
    expect(screen.getByTestId('data-source')).toHaveTextContent('Mock data')
  })

  it('serves labelled demo numbers in mock mode', async () => {
    render(<AnalyticsPage campaigns={campaigns} api={createAnalyticsApi({ mode: 'mock' })} />, { wrapper: AsManager })
    expect(await screen.findByText('12,450', {}, { timeout: 2000 })).toBeInTheDocument()
  })
})

describe('time range filter', () => {
  const periodsRequested = (calls) => new Set(calls.map(([, , period]) => JSON.stringify(period)))

  it('loads the last 30 days (including today) by default and shows which days', () => {
    const { api } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
    expect(screen.getByLabelText('Time range (UTC days)')).toHaveValue('30d')
    expect(periodsRequested(api.fetchMetric.mock.calls)).toEqual(new Set([JSON.stringify(toPeriod({ preset: '30d' }))]))
    expect(screen.getByTestId('analytics-period')).toHaveTextContent(formatRangeLabel({ preset: '30d' }))
  })

  it('reloads every metric for a new preset and ignores late answers for the old range', async () => {
    const { api, settle } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
    await userEvent.selectOptions(screen.getByLabelText('Time range (UTC days)'), '7d')

    const sevenDays = toPeriod({ preset: '7d' })
    const newCalls = api.fetchMetric.mock.calls.filter(([, , period]) => period.from === sevenDays.from)
    expect(newCalls.map(([, metric]) => metric).sort()).toEqual(['clickToBasket', 'clicks', 'impressions', 'sessions', 'uniqueCustomers'])
    expect(screen.getByTestId('analytics-period')).toHaveTextContent(formatRangeLabel({ preset: '7d' }))

    // The 30-day answer arrives after the switch: it must not show.
    await settle('campaign_001', 'clicks', 999, toPeriod({ preset: '30d' }))
    expect(card('Ad clicks')).toHaveAttribute('aria-busy', 'true')
    expect(document.body).not.toHaveTextContent('999')
    await settle('campaign_001', 'clicks', 7, sevenDays)
    expect(card('Ad clicks')).toHaveTextContent('7')
  })

  it('applies a valid custom range only when Apply is pressed', async () => {
    const { api } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
    await userEvent.selectOptions(screen.getByLabelText('Time range (UTC days)'), 'custom')
    const callsBefore = api.fetchMetric.mock.calls.length

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-10' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-01' } })
    expect(screen.getByRole('alert')).toHaveTextContent('The start date must be on or before the end date.')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(api.fetchMetric.mock.calls.length).toBe(callsBefore)

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(periodsRequested(api.fetchMetric.mock.calls.slice(callsBefore))).toEqual(
      new Set([JSON.stringify({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' })]),
    )
    expect(screen.getByTestId('analytics-period')).toHaveTextContent('Sep 1 – Oct 1, 2026 (UTC)')
  })

  it('applies the range to the campaign comparison too', async () => {
    const { api } = createDeferredApi()
    render(<AnalyticsPage campaigns={campaigns} api={api} />, { wrapper: AsManager })
    await userEvent.selectOptions(screen.getByLabelText('Campaign'), 'all')
    await userEvent.selectOptions(screen.getByLabelText('Time range (UTC days)'), '90d')
    const ninetyDays = toPeriod({ preset: '90d' })
    const ids = api.fetchMetric.mock.calls.filter(([, , period]) => period.from === ninetyDays.from).map(([id]) => id)
    expect(new Set(ids)).toEqual(new Set(campaigns.map((campaign) => campaign.id)))
  })
})

