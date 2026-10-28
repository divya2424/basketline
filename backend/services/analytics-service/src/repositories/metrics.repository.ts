import type { AnalyticsEventName } from '@shopsphere/contracts'
import type { ClickHouse } from '../clickhouse.ts'

/** ClickHouse DateTime64 parameter in UTC: "2026-10-28 12:00:00.000". */
const toDateTime = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '')

/** One tenant's campaign over [from, to). */
export interface MetricScope {
  tenantId: string
  campaignId: string
  from: Date
  to: Date
}

const scopeParams = ({ tenantId, campaignId, from, to }: MetricScope) => ({ tenantId, campaignId, from: toDateTime(from), to: toDateTime(to) })

async function single(clickhouse: ClickHouse, query: string, params: Record<string, unknown>): Promise<number> {
  const result = await clickhouse.query({ query, query_params: params, format: 'JSONEachRow' })
  const [row] = await result.json<{ count: string | number }>()
  return Number(row?.count ?? 0)
}

/**
 * Number of impression or click events in the scope.
 * uniqExact(event_id): a redelivered event counts once, even before
 * ReplacingMergeTree has merged the duplicate rows away. The WHERE clause
 * follows the table's sort key (tenant_id, event_name, campaign_id, event_time),
 * so ClickHouse reads only that slice.
 */
export function countEvents(clickhouse: ClickHouse, scope: MetricScope, eventName: AnalyticsEventName) {
  return single(
    clickhouse,
    `SELECT uniqExact(event_id) AS count FROM events
     WHERE tenant_id = {tenantId:UUID} AND event_name = {eventName:String} AND campaign_id = {campaignId:UUID}
       AND event_time >= {from:DateTime64(3, 'UTC')} AND event_time < {to:DateTime64(3, 'UTC')}`,
    { ...scopeParams(scope), eventName },
  )
}

const AGGREGATE_COLUMNS = {
  impressions: 'total_ad_impressions',
  clicks: 'total_ad_clicks',
  clickToBasket: 'total_click_to_basket',
} as const

/**
 * A metric summed over whole UTC days in [from, to) (both at midnight), from the
 * rows the aggregates job saved: one per (tenant, campaign, day).
 */
export function sumDailyAggregates(clickhouse: ClickHouse, { tenantId, campaignId, from, to }: MetricScope, metric: keyof typeof AGGREGATE_COLUMNS) {
  return single(
    clickhouse,
    `SELECT sum(${AGGREGATE_COLUMNS[metric]}) AS count FROM campaign_daily_aggregates
     WHERE tenant_id = {tenantId:UUID} AND campaign_id = {campaignId:UUID}
       AND day >= {from:Date} AND day < {to:Date}`,
    { tenantId, campaignId, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
  )
}

/**
 * Basket additions in the scope credited to a click on the same tenant's campaign:
 * the click exists, came at most 24 hours before, was for the same product (if
 * it named one) and the same user (if both were signed in). Each click is
 * credited once per product.
 */
export function countAttributedBasketAdditions(clickhouse: ClickHouse, scope: MetricScope) {
  return single(
    clickhouse,
    `SELECT uniqExact(basket.attribution_id, basket.product_id) AS count
     FROM events AS basket
     INNER JOIN (
       SELECT DISTINCT event_id, product_id, user_id, event_time FROM events
       WHERE tenant_id = {tenantId:UUID} AND event_name = 'click' AND campaign_id = {campaignId:UUID}
         -- Only clicks that can be credited for an addition in [from, to).
         AND event_time >= {from:DateTime64(3, 'UTC')} - INTERVAL 24 HOUR AND event_time < {to:DateTime64(3, 'UTC')}
     ) AS click ON basket.attribution_id = click.event_id
     WHERE basket.tenant_id = {tenantId:UUID} AND basket.event_name = 'click_to_basket' AND basket.campaign_id = {campaignId:UUID}
       AND basket.event_time >= {from:DateTime64(3, 'UTC')} AND basket.event_time < {to:DateTime64(3, 'UTC')}
       AND basket.event_time >= click.event_time AND basket.event_time <= click.event_time + INTERVAL 24 HOUR
       AND (click.product_id IS NULL OR click.product_id = basket.product_id)
       AND (click.user_id IS NULL OR basket.user_id IS NULL OR click.user_id = basket.user_id)`,
    scopeParams(scope),
  )
}
