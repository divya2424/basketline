import { badRequest } from '@ecommerce-analytics/platform'
import type { ClickHouse } from '../clickhouse.ts'
import { countDaily, type MetricCount, type MetricScope } from '../repositories/metrics.repository.ts'

/** API metric names (kept from the frontend contract). */
export const METRICS = ['clicks', 'impressions', 'clickToBasket', 'uniqueCustomers', 'sessions'] as const
export type MetricName = (typeof METRICS)[number]

const DAY = 24 * 60 * 60 * 1000
/** Distinct (tenant, campaign, metric, days) kept; random IDs must not grow it without bound. */
const CACHE_MAX = 10_000
const DEFAULT_RANGE_DAYS = 30
const MAX_RANGE_DAYS = 366

const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))

/**
 * Defaults to the last 30 days; rejects inverted or overly long ranges.
 * Snapped to whole UTC days, the grain of the daily totals: "from" down to
 * midnight, "to" up to the next midnight (so a period ending now includes today).
 */
export function resolvePeriod(from: string | undefined, to: string | undefined, now = new Date()) {
  const end = to ? new Date(to) : now
  const start = from ? new Date(from) : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY)
  if (start >= end) throw badRequest('INVALID_PERIOD', '"from" must be before "to"')
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY) throw badRequest('INVALID_PERIOD', `The period can be at most ${MAX_RANGE_DAYS} days`)
  const endDay = startOfUtcDay(end)
  return { from: startOfUtcDay(start), to: end.getTime() === endDay.getTime() ? end : new Date(endDay.getTime() + DAY) }
}

/**
 * cacheMs: how long a count is reused for the same tenant, campaign, metric and
 * days (0 = never). Viewers of the same campaign then cost one query per cacheMs,
 * and identical requests in flight share one. A failed query is not kept.
 */
export function createMetricsService({ clickhouse, cacheMs = 0 }: { clickhouse: ClickHouse; cacheMs?: number }) {
  const cache = new Map<string, { count: Promise<MetricCount>; until: number }>()

  function cachedCount(scope: MetricScope, metric: MetricName) {
    const key = `${scope.tenantId}:${scope.campaignId}:${metric}:${scope.from.toISOString()}:${scope.to.toISOString()}`
    const now = Date.now()
    let entry = cache.get(key)
    if (!entry || entry.until <= now) {
      if (cache.size >= CACHE_MAX) cache.clear()
      const created = { count: countDaily(clickhouse, scope, metric), until: now + cacheMs }
      created.count.catch(() => cache.get(key) === created && cache.delete(key))
      cache.set(key, (entry = created))
    }
    return entry.count
  }

  return {
    /**
     * A tenant's campaign metric over the period's days, as the daily tables'
     * columns: events of one kind in total and per client type (web, mobile),
     * with the customers behind them (also per user type); unique customers
     * (people who saw or clicked it); or sessions (that saw it, converted, and
     * their average duration; about 7 hours behind). Customer and session counts
     * are estimates within about 1% beyond a few thousand. Today's numbers are
     * live; past event counts are exact once the nightly check has run. An
     * unknown campaign simply has 0.
     */
    async count(tenantId: string, campaignId: string, metric: MetricName, from?: string, to?: string) {
      const period = resolvePeriod(from, to)
      const scope = { tenantId, campaignId, ...period }
      return { ...(await (cacheMs > 0 ? cachedCount(scope, metric) : countDaily(clickhouse, scope, metric))), period }
    },
  }
}

export type MetricsService = ReturnType<typeof createMetricsService>
