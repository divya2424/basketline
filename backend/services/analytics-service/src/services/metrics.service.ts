import { badRequest } from '@shopsphere/platform'
import type { ClickHouse } from '../clickhouse.ts'
import { countAttributedBasketAdditions, countEvents, sumDailyAggregates, type MetricScope } from '../repositories/metrics.repository.ts'

/** API metric names (kept from the frontend contract). */
export const METRICS = ['clicks', 'impressions', 'clickToBasket'] as const
export type MetricName = (typeof METRICS)[number]

const DAY = 24 * 60 * 60 * 1000
const DEFAULT_RANGE_DAYS = 30
const MAX_RANGE_DAYS = 366

const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))

/**
 * Defaults to the last 30 days; rejects inverted or overly long ranges.
 * Snapped to whole UTC days: "from" down to midnight, "to" up to the next
 * midnight, unless it falls today (today is counted up to "to").
 */
export function resolvePeriod(from: string | undefined, to: string | undefined, now = new Date()) {
  const end = to ? new Date(to) : now
  const start = from ? new Date(from) : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY)
  if (start >= end) throw badRequest('INVALID_PERIOD', '"from" must be before "to"')
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY) throw badRequest('INVALID_PERIOD', `The period can be at most ${MAX_RANGE_DAYS} days`)
  const endDay = startOfUtcDay(end)
  const snappedEnd = end >= startOfUtcDay(now) || end.getTime() === endDay.getTime() ? end : new Date(endDay.getTime() + DAY)
  return { from: startOfUtcDay(start), to: snappedEnd }
}

/** Raw-event count for [from, to), which lies within yesterday and today. */
function countRaw(clickhouse: ClickHouse, scope: MetricScope, metric: MetricName) {
  if (metric === 'clickToBasket') return countAttributedBasketAdditions(clickhouse, scope)
  return countEvents(clickhouse, scope, metric === 'clicks' ? 'click' : 'impression')
}

export function createMetricsService({ clickhouse }: { clickhouse: ClickHouse }) {
  return {
    /**
     * Number of events of one kind for a tenant's campaign in the period. Days before
     * yesterday come from the daily aggregates; yesterday and today from raw events, so
     * the result doesn't depend on when the hourly job last ran. Counts events, not
     * unique customers; an unknown campaign simply has 0.
     */
    async count(tenantId: string, campaignId: string, metric: MetricName, from?: string, to?: string) {
      const now = new Date()
      const period = resolvePeriod(from, to, now)
      const yesterday = new Date(startOfUtcDay(now).getTime() - DAY)
      const savedEnd = period.to < yesterday ? period.to : yesterday
      const [saved, recent] = await Promise.all([
        period.from < savedEnd ? sumDailyAggregates(clickhouse, { tenantId, campaignId, from: period.from, to: savedEnd }, metric) : 0,
        period.to > yesterday
          ? countRaw(clickhouse, { tenantId, campaignId, from: period.from > yesterday ? period.from : yesterday, to: period.to }, metric)
          : 0,
      ])
      return { count: saved + recent, period }
    },
  }
}

export type MetricsService = ReturnType<typeof createMetricsService>
