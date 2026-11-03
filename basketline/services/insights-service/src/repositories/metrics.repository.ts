import type { ClickHouse } from '@basketline/platform/clickhouse'

/** One tenant's campaign over the UTC days [from, to); both are midnights. */
export interface MetricScope {
  tenantId: string
  campaignId: string
  /** One store's numbers; without one, every store's together (sketches merge: a customer counts once). */
  storeId?: string
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
  // Sessions that saw or clicked the campaign, and those that converted (flink/sql/pipelines/03_sessions.sql).
  sessions: [
    {
      table: 'daily_campaign_sessions_aggregation',
      aggregate: 'uniqCombined64Merge',
      columns: ['total_sessions', 'total_web_sessions', 'total_mobile_sessions', 'total_converted_sessions'],
    },
  ],
} as const

export type DailyMetric = keyof typeof DAILY_METRICS

/** A metric's total (count), its customers (for impressions, clicks and clickToBasket), and all of its columns by name. */
export interface MetricCount {
  count: number
  customers?: number
  columns: Record<string, number>
}

/** Bounds on each /ad query: 10 s, 4 threads, 2 GB. A daily-table read takes milliseconds; these only stop a runaway one. */
export const READ_LIMITS = { max_execution_time: 10, max_threads: 4, max_memory_usage: String(2 * 1024 ** 3) }

/**
 * The settings of a read for one tenant: the limits, and the tenant, which the
 * reader user's row policy (infra/clickhouse/04_access.sql) matches every row
 * against, so the database returns no other tenant's rows whatever the query.
 */
export const tenantRead = (tenantId: string) => ({ ...READ_LIMITS, SQL_tenant_id: tenantId })

/**
 * A metric over the days in the scope, in one query per table: event counts
 * summed (from daily_campaign_aggregation, corrected hourly), and customers'
 * sketches merged (from daily_campaign_customers_aggregation, so a customer
 * active on several days, in several stores, on both apps, or as a visitor and
 * then registered counts once). Unique customers also get has_visited_in_both:
 * web + mobile - total. The WHERE clause follows the tables' sort key, and the
 * aggregates combine rows that background merges haven't combined yet.
 */
export async function countDaily(clickhouse: ClickHouse, { tenantId, campaignId, storeId, from, to }: MetricScope, metric: DailyMetric): Promise<MetricCount> {
  const sources = DAILY_METRICS[metric]
  const rows = await Promise.all(
    sources.map(async ({ table, aggregate, columns }) => {
      const result = await clickhouse.query({
        query: `SELECT ${columns.map((column) => `${aggregate}(${column}) AS ${column}`).join(', ')} FROM ${table}
                WHERE tenant_id = {tenantId:UUID} ${storeId ? 'AND store_id = {storeId:UUID}' : ''} AND campaign_id = {campaignId:UUID}
                  AND day >= {from:Date} AND day < {to:Date}`,
        query_params: { tenantId, storeId, campaignId, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        // One tenant's long range can't hold every core or run for long: other tenants' reads share them.
        clickhouse_settings: tenantRead(tenantId),
        format: 'JSONEachRow',
      })
      const [row = {}] = await result.json<Record<string, string | number | null>>()
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

/** One product's results in a campaign over a period, named as its campaign_product_added last sent it (null if never). */
export interface ProductResult {
  productId: string
  name: string | null
  category: string | null
  price: number | null
  impressions: number
  clicks: number
  addToCarts: number
}

/**
 * A campaign's results per product over the days in the scope (one store's, or
 * all), most impressions first, in one query: the daily per-product rows summed,
 * joined to the products' latest names. Products without activity in the period
 * aren't listed.
 */
export async function productResults(clickhouse: ClickHouse, { tenantId, campaignId, storeId, from, to }: MetricScope): Promise<ProductResult[]> {
  const result = await clickhouse.query({
    query: `SELECT toString(product_id) AS productId, name, category, price, impressions, clicks, addToCarts
            FROM (
              SELECT product_id, sum(impressions) AS impressions, sum(clicks) AS clicks, sum(click_to_basket) AS addToCarts
              FROM daily_campaign_product_aggregation
              WHERE tenant_id = {tenantId:UUID} ${storeId ? 'AND store_id = {storeId:UUID}' : ''} AND campaign_id = {campaignId:UUID}
                AND day >= {from:Date} AND day < {to:Date}
              GROUP BY product_id
            ) AS results
            LEFT JOIN (
              SELECT product_id, argMax(product_name, updated_at) AS name, argMax(category, updated_at) AS category, argMax(product_price, updated_at) AS price
              FROM campaign_products
              WHERE tenant_id = {tenantId:UUID} AND campaign_id = {campaignId:UUID}
              GROUP BY product_id
            ) AS names USING product_id
            ORDER BY impressions DESC, productId`,
    query_params: { tenantId, storeId, campaignId, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    // A product never named gets NULLs, not empty values.
    clickhouse_settings: { ...tenantRead(tenantId), join_use_nulls: 1 },
    format: 'JSONEachRow',
  })
  const rows = await result.json<Record<string, string | number | null>>()
  return rows.map((row) => ({
    productId: String(row.productId),
    name: row.name === null ? null : String(row.name),
    category: row.category === null ? null : String(row.category),
    price: row.price === null ? null : Number(row.price),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    addToCarts: Number(row.addToCarts),
  }))
}
