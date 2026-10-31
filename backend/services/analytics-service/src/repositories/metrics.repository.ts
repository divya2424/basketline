import type { ClickHouse } from '../clickhouse.ts'

/** One tenant's campaign over the UTC days [from, to); both are midnights. */
export interface MetricScope {
  tenantId: string
  /** One campaign, or all of a seller's (their sketches merge: a customer counts once). */
  campaignIds: string[]
  from: Date
  to: Date
}

/** The daily customers' sketch columns of one /ad metric: in total, per client type and per user type. */
const customers = (metric: string) =>
  ['', 'web_', 'mobile_', 'registered_', 'visitor_'].map((split) => `customers_${split}${metric}`)

/**
 * Per metric: the daily tables it reads, how each table's rows add up (sum of
 * event counts, merge of sketches, or of average states), and their columns,
 * which are also the response's fields; the first column is the total (count).
 */
const DAILY_METRICS = {
  impressions: [
    { table: 'daily_campaign_aggregation', aggregate: 'sum', columns: ['total_impressions', 'total_web_impressions', 'total_mobile_impressions'] },
    { table: 'daily_campaign_customers_aggregation', aggregate: 'uniqCombined64Merge', columns: customers('impressions') },
  ],
  clicks: [
    { table: 'daily_campaign_aggregation', aggregate: 'sum', columns: ['total_clicks', 'total_web_clicks', 'total_mobile_clicks'] },
    { table: 'daily_campaign_customers_aggregation', aggregate: 'uniqCombined64Merge', columns: customers('clicks') },
  ],
  clickToBasket: [
    { table: 'daily_campaign_aggregation', aggregate: 'sum', columns: ['total_click_to_basket', 'total_web_click_to_basket', 'total_mobile_click_to_basket'] },
    { table: 'daily_campaign_customers_aggregation', aggregate: 'uniqCombined64Merge', columns: customers('click_to_basket') },
  ],
  uniqueCustomers: [
    {
      table: 'daily_campaign_customers_aggregation',
      aggregate: 'uniqCombined64Merge',
      columns: ['has_visited', 'has_visited_in_web', 'has_visited_in_mobile', 'has_visited_registered', 'has_visited_visitor'],
    },
  ],
  sessions: [
    { table: 'daily_campaign_sessions_aggregation', aggregate: 'uniqCombined64Merge', columns: ['total_sessions', 'total_converted_sessions'] },
    { table: 'daily_campaign_sessions_aggregation', aggregate: 'avgMerge', columns: ['avg_session_duration_ms'] },
  ],
} as const

export type DailyMetric = keyof typeof DAILY_METRICS

/** A metric's total (count), its customers (for impressions, clicks and clickToBasket), and all of its columns by name. */
export interface MetricCount {
  count: number
  customers?: number
  columns: Record<string, number>
}

/**
 * A metric over the days in the scope, in one query per table: event counts
 * summed (from daily_campaign_aggregation, corrected nightly), customers'
 * sketches merged (from daily_campaign_customers_aggregation, so a customer
 * active on several days, on both apps, or as a visitor and then registered
 * counts once), and sessions (from daily_campaign_sessions_aggregation).
 * Unique customers also get has_visited_in_both: web + mobile - total. The WHERE
 * clause follows the tables' sort key, so ClickHouse reads only that campaign's
 * days, and the aggregates combine rows that background merges haven't combined yet.
 */
export async function countDaily(clickhouse: ClickHouse, { tenantId, campaignIds, from, to }: MetricScope, metric: DailyMetric): Promise<MetricCount> {
  const sources = DAILY_METRICS[metric]
  const rows = await Promise.all(
    sources.map(async ({ table, aggregate, columns }) => {
      const result = await clickhouse.query({
        query: `SELECT ${columns.map((column) => `${aggregate}(${column}) AS ${column}`).join(', ')} FROM ${table}
                WHERE tenant_id = {tenantId:UUID} AND campaign_id IN {campaignIds:Array(UUID)}
                  AND day >= {from:Date} AND day < {to:Date}`,
        query_params: { tenantId, campaignIds, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        format: 'JSONEachRow',
      })
      const [row = {}] = await result.json<Record<string, string | number | null>>()
      // avgMerge of no rows is NaN (null in JSON): no sessions, so 0.
      return columns.map((column) => [column, Number(row[column] ?? 0) || 0] as const)
    }),
  )
  const counts: Record<string, number> = Object.fromEntries(rows.flat())
  if (metric === 'uniqueCustomers') {
    // Estimates beyond a few thousand customers can make this slightly negative.
    counts.has_visited_in_both = Math.max(0, counts.has_visited_in_web! + counts.has_visited_in_mobile! - counts.has_visited!)
  }
  const customerColumn = sources[1]?.columns[0]
  return {
    count: counts[sources[0].columns[0]]!,
    ...(customerColumn?.startsWith('customers_') ? { customers: counts[customerColumn]! } : {}),
    columns: counts,
  }
}
