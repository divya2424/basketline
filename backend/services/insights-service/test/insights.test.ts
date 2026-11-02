import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@basketline/platform'
import type { ClickHouse } from '@basketline/platform/clickhouse'
import { createTestClickHouse, createTestKeys, tokenFor, visitorTokenFor, type TestKeys } from '@basketline/platform/testing'
import { buildInsightsApp } from '../src/app.ts'

const HOUR = 3_600_000
const TENANT = '10000000-0000-4000-8000-000000000001'
const OTHER_TENANT = '20000000-0000-4000-8000-000000000002'
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const logger = createLogger('insights-test')

let keys: TestKeys
/** A campaign manager of TENANT. */
let reader: string
/** A visitor of TENANT (not allowed to read metrics). */
let visitor: string
let db: Awaited<ReturnType<typeof createTestClickHouse>>
/** The services' own user: these tests seed rows with it, as ingestion and Flink would. */
let clickhouse: ClickHouse
/** The tenant-scoped reader (infra/clickhouse/04_access.sql), which the app reads as. */
let readClickhouse: ClickHouse
let app: ReturnType<typeof buildInsightsApp>

beforeAll(async () => {
  keys = await createTestKeys()
  reader = (await tokenFor(keys, 'campaign-manager', { tid: TENANT })).header
  visitor = (await visitorTokenFor(keys, TENANT)).header
  db = await createTestClickHouse()
  clickhouse = db.clickhouse
  readClickhouse = db.reader
  app = buildInsightsApp({ clickhouse: readClickhouse, logger, publicKey: keys.publicKey })
})

afterAll(async () => {
  await db.drop()
})

/** A campaign in the campaigns copy, as ingestion-service keeps it from the retail API. */
async function insertCampaign(campaignId: string, sellerId: string) {
  await clickhouse.insert({
    table: 'campaigns',
    format: 'JSONEachRow',
    values: [{ campaign_id: campaignId, tenant_id: TENANT, status: 'active', archived: false, version: 1, seller_id: sellerId }],
  })
}

interface Row {
  event_id?: string
  event_name: string
  campaign_id?: string | null
  product_id?: string | null
  user_id?: string | null
  user_type?: 'visitor' | 'registered'
  client_type?: 'web' | 'mobile'
  tenant_id?: string
  event_time?: string
}

async function insert(rows: Row[]) {
  await clickhouse.insert({
    table: 'events',
    format: 'JSONEachRow',
    clickhouse_settings: { date_time_input_format: 'best_effort' },
    values: rows.map((row) => ({
      event_id: randomUUID(),
      tenant_id: TENANT,
      user_type: 'visitor',
      event_time: ago(60_000),
      received_at: new Date().toISOString(),
      properties: '{}',
      ...row,
    })),
  })
}

/**
 * A candidate click for a basket addition, as the Flink job writes it (it
 * applies the attribution rules); ClickHouse credits each basket's latest click.
 */
interface AttributedBasket {
  basket_event_id?: string
  click_event_id: string
  campaign_id: string
  client_type?: 'web' | 'mobile'
  product_id?: string
  user_id?: string
  user_type?: 'visitor' | 'registered'
  tenant_id?: string
  event_time?: string
  click_time?: string
}

async function insertAttributed(rows: AttributedBasket[]) {
  await clickhouse.insert({
    table: 'attributed_baskets',
    format: 'JSONEachRow',
    clickhouse_settings: { date_time_input_format: 'best_effort' },
    values: rows.map((row) => {
      const event_time = row.event_time ?? ago(60_000)
      return {
        basket_event_id: randomUUID(),
        tenant_id: TENANT,
        product_id: randomUUID(),
        user_id: randomUUID(),
        user_type: 'visitor',
        event_time,
        click_time: event_time,
        ...row,
      }
    }),
  })
}

const metric = (campaignId: string, name: string, query = '', auth = reader) =>
  request(app).get(`/api/v1/ad/${campaignId}/${name}${query}`).set('Authorization', auth)

describe('the /ad metrics, read from ClickHouse', () => {
  it('counts impressions and clicks per campaign, counting a redelivered event once', async () => {
    const campaignId = randomUUID()
    const duplicate = randomUUID()
    await insert([
      { campaign_id: campaignId, event_name: 'impression' },
      { campaign_id: campaignId, event_name: 'impression', event_id: duplicate },
      { campaign_id: campaignId, event_name: 'impression', event_id: duplicate },
      { campaign_id: campaignId, event_name: 'click' },
      { campaign_id: randomUUID(), event_name: 'click' },
      { campaign_id: campaignId, event_name: 'add_to_cart' },
    ])
    const impressions = await metric(campaignId, 'impressions')
    expect(impressions.status).toBe(200)
    expect(impressions.body).toMatchObject({ campaignId, metric: 'impressions', count: 2 })
    // The last 30 days, from midnight.
    expect(impressions.body.period.from).toBe(new Date(Math.floor((Date.now() - 30 * 24 * HOUR) / (24 * HOUR)) * 24 * HOUR).toISOString())
    expect((await metric(campaignId, 'clicks')).body.count).toBe(1)
  })

  it('filters by date range and validates the period', async () => {
    const campaignId = randomUUID()
    await insert([
      { campaign_id: campaignId, event_name: 'click', event_time: ago(6 * 24 * HOUR) },
      { campaign_id: campaignId, event_name: 'click', event_time: ago(24 * HOUR) },
    ])
    const from = ago(3 * 24 * HOUR)
    const to = new Date().toISOString()
    // Whole UTC days: "from" snaps down to midnight, "to" up to the next one, so today is included.
    const snapped = new Date(Math.floor(new Date(from).getTime() / (24 * HOUR)) * 24 * HOUR).toISOString()
    const tomorrow = new Date((Math.floor(Date.now() / (24 * HOUR)) + 1) * 24 * HOUR).toISOString()
    expect((await metric(campaignId, 'clicks', `?from=${from}&to=${to}`)).body).toMatchObject({ count: 1, period: { from: snapped, to: tomorrow } })
    expect((await metric(campaignId, 'clicks', `?from=${new Date().toISOString()}&to=${ago(HOUR)}`)).body.error.code).toBe('INVALID_PERIOD')
    expect((await metric(campaignId, 'clicks', '?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z')).body.error.code).toBe('INVALID_PERIOD')
    expect((await metric(campaignId, 'clicks', '?from=yesterday')).status).toBe(400)
  })

  // The attribution rules themselves are applied by the Flink job (test/flink.kafka.test.ts).
  it("credits each basket addition to its latest click, once per click and product, per tenant and campaign", async () => {
    const [campaignId, otherCampaign] = [randomUUID(), randomUUID()]
    const [product, otherProduct] = [randomUUID(), randomUUID()]
    const [click, otherClick] = [randomUUID(), randomUUID()]
    const [shopper, otherShopper] = [randomUUID(), randomUUID()]
    const twice = randomUUID()
    const basket = { campaign_id: campaignId, product_id: product, user_id: shopper }
    await insertAttributed([
      { ...basket, click_event_id: click }, // ✓
      { ...basket, click_event_id: click }, // the same click and product added to the cart again: once
      { ...basket, click_event_id: otherClick, user_id: otherShopper }, // ✓ another shopper
      // One basket addition, two candidate clicks: the later one (otherCampaign) wins.
      { basket_event_id: twice, click_event_id: randomUUID(), campaign_id: campaignId, product_id: otherProduct, user_id: shopper, click_time: ago(3 * HOUR) },
      { basket_event_id: twice, click_event_id: randomUUID(), campaign_id: otherCampaign, product_id: otherProduct, user_id: shopper, click_time: ago(2 * HOUR) },
      { ...basket, click_event_id: randomUUID(), tenant_id: OTHER_TENANT }, // another tenant
    ])
    expect((await metric(campaignId, 'clickToBasket')).body).toMatchObject({ count: 2, customers: 2 })
    expect((await metric(otherCampaign, 'clickToBasket')).body).toMatchObject({ count: 1, customers: 1 })
  })

  it("counts only the caller's own tenant's events; a tenant_id header can't change that", async () => {
    const campaignId = randomUUID()
    await insert([
      { campaign_id: campaignId, event_name: 'click' },
      { campaign_id: campaignId, event_name: 'click', tenant_id: OTHER_TENANT },
      { campaign_id: campaignId, event_name: 'click', tenant_id: OTHER_TENANT },
    ])
    expect((await metric(campaignId, 'clicks')).body.count).toBe(1)
    expect((await metric(campaignId, 'clicks').set('tenant_id', OTHER_TENANT)).body.count).toBe(1)
    const otherManager = (await tokenFor(keys, 'campaign-manager', { tid: OTHER_TENANT })).header
    expect((await metric(campaignId, 'clicks', '', otherManager)).body.count).toBe(2)
  })

  it('is only for campaign managers: not shoppers, and not visitor tokens', async () => {
    const shopper = (await tokenFor(keys, 'standard-user', { tid: TENANT })).header
    expect((await metric(randomUUID(), 'clicks', '', shopper)).status).toBe(403)
    expect((await metric(randomUUID(), 'clicks', '', visitor)).status).toBe(401)
  })

  it('returns 0 for an unknown campaign, and requires a token and a known metric', async () => {
    expect((await metric(randomUUID(), 'clicks')).body.count).toBe(0)
    expect((await metric(randomUUID(), 'uniqueCustomers')).body.count).toBe(0)
    expect((await request(app).get(`/api/v1/ad/${randomUUID()}/clicks`)).status).toBe(401)
    expect((await metric(randomUUID(), 'conversions')).body.error.code).toBe('UNKNOWN_METRIC')
    expect((await metric('not-a-uuid', 'clicks')).status).toBe(400)
  })
})

const DAY = 24 * HOUR
/** UTC midnight, `days` days ago. */
const midnight = (days: number) => new Date(Math.floor(Date.now() / DAY) * DAY - days * DAY)
const atDay = (days: number, hour: number) => new Date(midnight(days).getTime() + hour * HOUR).toISOString()
const dayString = (days: number) => midnight(days).toISOString().slice(0, 10)

/** What runs every hour: recount the days that changed, today included, and add the difference. */
async function runCheck() {
  await clickhouse.command({ query: `SYSTEM REFRESH VIEW ${db.database}.daily_campaign_aggregation_check_mv` })
  await clickhouse.command({ query: `SYSTEM WAIT VIEW ${db.database}.daily_campaign_aggregation_check_mv` })
}

/** One campaign's daily totals, as /ad sees them (rows not merged yet are added up). */
async function dailyTotals(campaignId: string) {
  const result = await clickhouse.query({
    query: `SELECT toString(day) AS day, toString(tenant_id) AS tenant_id,
                   sum(total_impressions) AS impressions, sum(total_clicks) AS clicks, sum(total_click_to_basket) AS click_to_basket
            FROM daily_campaign_aggregation WHERE campaign_id = {campaignId:UUID}
            GROUP BY day, tenant_id ORDER BY tenant_id, day`,
    query_params: { campaignId },
    format: 'JSONEachRow',
    clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
  })
  return result.json()
}

describe('daily_campaign_aggregation: the daily totals /ad reads', () => {
  it('adds each stored row to its day as it arrives, a late one to its own day', async () => {
    const campaignId = randomUUID()
    const product = randomUUID()
    const duplicate = randomUUID()
    const [click, earlierClick] = [randomUUID(), randomUUID()]
    const basket = (click_event_id: string, event_time: string): AttributedBasket => ({ click_event_id, campaign_id: campaignId, product_id: product, event_time })
    await insert([
      { campaign_id: campaignId, event_name: 'impression', event_time: atDay(1, 10) },
      { campaign_id: campaignId, event_name: 'impression', event_id: duplicate, event_time: atDay(1, 10) },
      { campaign_id: campaignId, event_name: 'impression', event_id: duplicate, event_time: atDay(1, 10) }, // same batch: once
      { event_id: click, event_name: 'click', campaign_id: campaignId, product_id: product, event_time: atDay(1, 9) },
      { campaign_id: campaignId, event_name: 'click', tenant_id: OTHER_TENANT, event_time: atDay(1, 11) },
      { campaign_id: campaignId, event_name: 'impression', event_time: atDay(0, 0) },
      { campaign_id: campaignId, event_name: 'add_to_cart', event_time: atDay(1, 12) }, // not a metric event
    ])
    await insertAttributed([
      basket(click, atDay(1, 10)),
      basket(click, atDay(1, 11)), // same click and product, same batch: once
      basket(earlierClick, atDay(1, 1)), // counted on the basket's day, not the click's
    ])
    // Stored days after it happened: it counts for its own day, at once.
    await insert([{ campaign_id: campaignId, event_name: 'impression', event_time: atDay(3, 15) }])

    expect(await dailyTotals(campaignId)).toEqual([
      { day: dayString(3), tenant_id: TENANT, impressions: 1, clicks: 0, click_to_basket: 0 },
      { day: dayString(1), tenant_id: TENANT, impressions: 2, clicks: 1, click_to_basket: 2 },
      { day: dayString(0), tenant_id: TENANT, impressions: 1, clicks: 0, click_to_basket: 0 },
      { day: dayString(1), tenant_id: OTHER_TENANT, impressions: 0, clicks: 1, click_to_basket: 0 },
    ].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)))
  })

  it('counts a copy stored in another batch until the hourly check corrects the day, today included', async () => {
    const campaignId = randomUUID()
    const product = randomUUID()
    const [click, todaysClick, clickWithBasket] = [randomUUID(), randomUUID(), randomUUID()]
    const sent = { event_id: click, event_name: 'click', campaign_id: campaignId, event_time: atDay(1, 9) }
    const today = { event_id: todaysClick, event_name: 'click', campaign_id: campaignId, event_time: ago(60_000) }
    const credited: AttributedBasket = { click_event_id: clickWithBasket, campaign_id: campaignId, product_id: product, event_time: atDay(1, 10) }
    await insert([sent, today])
    await insertAttributed([credited])
    // Redelivered later (a retry, or a replay after a restart): a separate batch each.
    await insert([sent, today])
    await insertAttributed([credited])

    const lastTwoDays = `?from=${midnight(1).toISOString()}`
    expect((await metric(campaignId, 'clicks', lastTwoDays)).body.count).toBe(4)
    expect((await metric(campaignId, 'clickToBasket', lastTwoDays)).body.count).toBe(2)

    await runCheck()
    // Yesterday and today are exact now.
    expect(await dailyTotals(campaignId)).toEqual([
      { day: dayString(1), tenant_id: TENANT, impressions: 0, clicks: 1, click_to_basket: 1 },
      { day: dayString(0), tenant_id: TENANT, impressions: 0, clicks: 1, click_to_basket: 0 },
    ])

    // Running it again changes nothing: a day that is right gets no correction.
    await runCheck()
    expect((await metric(campaignId, 'clicks', lastTwoDays)).body.count).toBe(2)
  })

  it('moves a basket addition to a later click that arrives in another batch, once the hourly check runs', async () => {
    const [first, second] = [randomUUID(), randomUUID()]
    const basket = { basket_event_id: randomUUID(), product_id: randomUUID(), user_id: randomUUID(), event_time: atDay(1, 12) }
    await insertAttributed([{ ...basket, click_event_id: randomUUID(), campaign_id: first, click_time: atDay(1, 8) }])
    // A later click on the same product, in another campaign, arrives late.
    await insertAttributed([{ ...basket, click_event_id: randomUUID(), campaign_id: second, click_time: atDay(1, 10) }])
    const yesterday = `?from=${midnight(1).toISOString()}`
    // Live, each batch credits its own latest click.
    expect((await metric(first, 'clickToBasket', yesterday)).body.count).toBe(1)
    expect((await metric(second, 'clickToBasket', yesterday)).body.count).toBe(1)

    await runCheck()
    // The first campaign had nothing else that day, and is corrected to 0.
    expect((await metric(first, 'clickToBasket', yesterday)).body.count).toBe(0)
    expect((await metric(second, 'clickToBasket', yesterday)).body.count).toBe(1)
  })

  it('answers any range of days from the daily totals', async () => {
    const campaignId = randomUUID()
    await insert([
      { campaign_id: campaignId, event_name: 'click', event_time: atDay(3, 12) },
      { campaign_id: campaignId, event_name: 'click', event_time: atDay(1, 12) },
      { campaign_id: campaignId, event_name: 'click', event_time: ago(1_000) },
    ])
    expect((await metric(campaignId, 'clicks')).body.count).toBe(3)
    // Yesterday and today.
    expect((await metric(campaignId, 'clicks', `?from=${midnight(1).toISOString()}`)).body.count).toBe(2)
    // Snapped to whole days: [3 days ago 00:00, 2 days ago 00:00).
    const oneDay = await metric(campaignId, 'clicks', `?from=${atDay(3, 18)}&to=${atDay(3, 20)}`)
    expect(oneDay.body).toMatchObject({ count: 1, period: { from: midnight(3).toISOString(), to: midnight(2).toISOString() } })
  })
})

describe('daily_campaign_customers_aggregation: unique customers', () => {
  it('counts each customer who saw or clicked the campaign once per period, whatever the days or copies', async () => {
    const campaignId = randomUUID()
    const [visitor, user, otherVisitor] = [randomUUID(), randomUUID(), randomUUID()]
    const copy = randomUUID()
    await insert([
      // Two days ago: a visitor and a registered user.
      { campaign_id: campaignId, event_name: 'impression', user_id: visitor, event_time: atDay(2, 10) },
      { campaign_id: campaignId, event_name: 'click', user_id: user, user_type: 'registered', event_time: atDay(2, 11) },
      // Yesterday: the same visitor again, and another one whose impression arrives twice.
      { campaign_id: campaignId, event_name: 'click', user_id: visitor, event_time: atDay(1, 9) },
      { campaign_id: campaignId, event_name: 'impression', user_id: otherVisitor, event_id: copy, event_time: atDay(1, 10) },
      // Not counted: a basket addition, another campaign, another tenant, and an event with no customer ID.
      { campaign_id: campaignId, event_name: 'add_to_cart', user_id: randomUUID(), event_time: atDay(1, 12) },
      { campaign_id: randomUUID(), event_name: 'impression', user_id: randomUUID(), event_time: atDay(1, 12) },
      { campaign_id: campaignId, event_name: 'impression', user_id: randomUUID(), tenant_id: OTHER_TENANT, event_time: atDay(1, 12) },
      { campaign_id: campaignId, event_name: 'impression', event_time: atDay(1, 12) },
    ])
    await insert([{ campaign_id: campaignId, event_name: 'impression', user_id: otherVisitor, event_id: copy, event_time: atDay(1, 10) }])

    const unique = await metric(campaignId, 'uniqueCustomers')
    expect(unique.status).toBe(200)
    expect(unique.body).toMatchObject({ campaignId, metric: 'uniqueCustomers', count: 3, has_visited_registered: 1, has_visited_visitor: 2 })
    // Each day on its own: the visitor active on both days counts in each, once overall.
    expect((await metric(campaignId, 'uniqueCustomers', `?from=${atDay(2, 0)}&to=${midnight(1).toISOString()}`)).body.count).toBe(2)
    expect((await metric(campaignId, 'uniqueCustomers', `?from=${atDay(1, 0)}&to=${midnight(0).toISOString()}`)).body.count).toBe(2)
  })

  it('returns the customers behind impressions, clicks and click-to-basket, per client and user type', async () => {
    const campaignId = randomUUID()
    const [visitor, user] = [randomUUID(), randomUUID()]
    await insert([
      { campaign_id: campaignId, event_name: 'impression', user_id: visitor, event_time: atDay(1, 9) },
      { campaign_id: campaignId, event_name: 'impression', user_id: visitor, event_time: atDay(0, 0) },
      { campaign_id: campaignId, event_name: 'impression', user_id: user, user_type: 'registered', client_type: 'mobile' },
      { campaign_id: campaignId, event_name: 'click', user_id: visitor },
      { campaign_id: campaignId, event_name: 'click', user_id: visitor },
    ])
    await insertAttributed([
      { click_event_id: randomUUID(), campaign_id: campaignId, user_id: user, user_type: 'registered', client_type: 'mobile' },
      { click_event_id: randomUUID(), campaign_id: campaignId, user_id: user, user_type: 'registered', client_type: 'mobile' },
    ])
    expect((await metric(campaignId, 'impressions')).body).toMatchObject({
      count: 3,
      customers: 2,
      customers_impressions: 2,
      customers_web_impressions: 1,
      customers_mobile_impressions: 1,
      customers_registered_impressions: 1,
      customers_visitor_impressions: 1,
    })
    expect((await metric(campaignId, 'clicks')).body).toMatchObject({ count: 2, customers: 1, customers_visitor_clicks: 1, customers_registered_clicks: 0 })
    expect((await metric(campaignId, 'clickToBasket')).body).toMatchObject({
      count: 2,
      customers: 1,
      customers_mobile_click_to_basket: 1,
      customers_web_click_to_basket: 0,
      customers_registered_click_to_basket: 1,
    })
    // Unique customers and sessions have no separate customers field.
    expect((await metric(campaignId, 'uniqueCustomers')).body).not.toHaveProperty('customers')
  })
})

/** Sessions as the Flink job writes them (through Kafka); 03_kafka.sql derives session_id. */
async function insertSession(session: { campaigns: string[]; clicked?: string[]; added?: string[]; minutes: number; start?: string; session_id?: string }) {
  const start = session.start ?? ago(10 * HOUR)
  await clickhouse.insert({
    table: 'sessions',
    format: 'JSONEachRow',
    clickhouse_settings: { date_time_input_format: 'best_effort' },
    values: [
      {
        session_id: session.session_id ?? randomUUID(),
        tenant_id: TENANT,
        user_id: randomUUID(),
        user_type: 'visitor',
        session_start: start,
        last_event_time: new Date(new Date(start).getTime() + session.minutes * 60_000).toISOString(),
        events: 3,
        impressions: 1,
        clicks: 1,
        add_to_carts: 1,
        web: true,
        mobile: false,
        campaigns: session.campaigns,
        clicked: session.clicked ?? [],
        added: session.added ?? [],
      },
    ],
  })
}

describe('daily_campaign_sessions_aggregation: sessions', () => {
  it('counts the sessions that saw a campaign, those that converted, and their average duration', async () => {
    const [campaignId, otherCampaign] = [randomUUID(), randomUUID()]
    const [product, otherProduct] = [randomUUID(), randomUUID()]
    const repeated = randomUUID()
    // Converted: clicked the product in this campaign and added it to the cart.
    await insertSession({ campaigns: [campaignId, otherCampaign], clicked: [`${campaignId}:${product}`], added: [product], minutes: 30, session_id: repeated })
    // Written again after a Flink restart: counts once.
    await insertSession({ campaigns: [campaignId, otherCampaign], clicked: [`${campaignId}:${product}`], added: [product], minutes: 30, session_id: repeated })
    // Not converted: added another product than the one clicked.
    await insertSession({ campaigns: [campaignId], clicked: [`${campaignId}:${product}`], added: [otherProduct], minutes: 10 })

    const sessions = await metric(campaignId, 'sessions')
    expect(sessions.status).toBe(200)
    expect(sessions.body).toMatchObject({ metric: 'sessions', count: 2, total_sessions: 2, total_converted_sessions: 1 })
    expect(sessions.body).not.toHaveProperty('customers')
    // (30 + 30 + 10) / 3 rows: a repeated session counts in the average.
    expect(sessions.body.avg_session_duration_ms).toBeCloseTo((70 / 3) * 60_000, -3)
    // Seen, but the click and the basket were for another campaign.
    expect((await metric(otherCampaign, 'sessions')).body).toMatchObject({ count: 1, total_converted_sessions: 0 })
    expect((await metric(randomUUID(), 'sessions')).body).toMatchObject({ count: 0, avg_session_duration_ms: 0 })
  })
})

describe('a visitor who registers', () => {
  it('counts once, as both a visitor and a registered user: the client keeps their UUID', async () => {
    const campaignId = randomUUID()
    const person = randomUUID()
    await insert([
      { campaign_id: campaignId, event_name: 'impression', user_id: person, event_time: atDay(1, 9) },
      { campaign_id: campaignId, event_name: 'click', user_id: person, user_type: 'registered', client_type: 'mobile', event_time: atDay(1, 10) },
      { campaign_id: campaignId, event_name: 'impression', user_id: person, user_type: 'registered', client_type: 'mobile' },
    ])
    expect((await metric(campaignId, 'uniqueCustomers')).body).toMatchObject({
      count: 1,
      has_visited_registered: 1,
      has_visited_visitor: 1,
      has_visited_in_web: 1,
      has_visited_in_mobile: 1,
      has_visited_in_both: 1,
    })
  })
})

describe('web, mobile and total', () => {
  it('counts every metric per client type, and in total: event counts add up, a customer on both counts once', async () => {
    const campaignId = randomUUID()
    const [both, webOnly] = [randomUUID(), randomUUID()]
    await insert([
      { campaign_id: campaignId, event_name: 'impression', user_id: both, client_type: 'web' },
      { campaign_id: campaignId, event_name: 'impression', user_id: both, client_type: 'mobile' },
      { campaign_id: campaignId, event_name: 'click', user_id: both, client_type: 'mobile' },
      { campaign_id: campaignId, event_name: 'impression', user_id: webOnly },
    ])
    await insertAttributed([{ click_event_id: randomUUID(), campaign_id: campaignId, product_id: randomUUID(), client_type: 'mobile' }])

    const body = async (name: string) => (await metric(campaignId, name)).body
    expect(await body('impressions')).toMatchObject({ count: 3, total_impressions: 3, total_web_impressions: 2, total_mobile_impressions: 1 })
    expect(await body('clicks')).toMatchObject({ count: 1, total_clicks: 1, total_web_clicks: 0, total_mobile_clicks: 1 })
    expect(await body('clickToBasket')).toMatchObject({
      count: 1,
      total_click_to_basket: 1,
      total_web_click_to_basket: 0,
      total_mobile_click_to_basket: 1,
    })
    // 2 people: one on web only, one on both (counted once in the total).
    expect(await body('uniqueCustomers')).toMatchObject({
      count: 2,
      has_visited: 2,
      has_visited_in_web: 2,
      has_visited_in_mobile: 1,
      has_visited_in_both: 1,
    })
    // One row per campaign and day in both daily tables, not one per client type.
    for (const table of ['daily_campaign_aggregation', 'daily_campaign_customers_aggregation']) {
      const rows = await clickhouse.query({
        query: `SELECT count() AS rows FROM ${table} FINAL WHERE campaign_id = {campaignId:UUID}`,
        query_params: { campaignId },
        format: 'JSONEachRow',
      })
      expect(await rows.json()).toEqual([{ rows: 1 }])
    }
  })
})

describe('/ad query limits', () => {
  it("bounds every query's time, threads and memory, so one tenant's long range can't hold every core", async () => {
    const query = vi.spyOn(readClickhouse, 'query')
    try {
      const res = await request(app).get(`/api/v1/ad/${randomUUID()}/clicks`).set('Authorization', reader)
      expect(res.status).toBe(200)
      const settings = query.mock.calls.map(([params]) => params.clickhouse_settings)
      expect(settings.length).toBeGreaterThan(0)
      for (const s of settings) expect(s).toEqual({ max_execution_time: 10, max_threads: 4, max_memory_usage: String(2 * 1024 ** 3), SQL_tenant_id: TENANT })
    } finally {
      query.mockRestore()
    }
  })
})

describe("ClickHouse's tenant isolation (the reader user's row policy)", () => {
  it('returns only the named tenant\'s rows, even to a query without a tenant filter, and nothing without a tenant', async () => {
    const campaignId = randomUUID()
    await insert([
      { campaign_id: campaignId, event_name: 'impression', user_id: randomUUID() },
      { campaign_id: campaignId, event_name: 'impression', user_id: randomUUID(), tenant_id: OTHER_TENANT },
    ])
    const tenantsSeen = async (settings: Record<string, string>) =>
      (await (await readClickhouse.query({ query: `SELECT DISTINCT toString(tenant_id) AS t FROM events WHERE campaign_id = {c:UUID}`, query_params: { c: campaignId }, clickhouse_settings: settings, format: 'JSONEachRow' })).json<{ t: string }>()).map((row) => row.t)
    expect(await tenantsSeen({ SQL_tenant_id: TENANT })).toEqual([TENANT])
    expect(await tenantsSeen({ SQL_tenant_id: OTHER_TENANT })).toEqual([OTHER_TENANT])
    expect(await tenantsSeen({})).toEqual([])
    // The reader can't write.
    await expect(readClickhouse.command({ query: `INSERT INTO tenants VALUES (generateUUIDv4(), 'enterprise', 1)` })).rejects.toThrow(/Not enough privileges/)
  })
})

describe('the /ad cache', () => {
  it('reuses a count for the same campaign, metric and days, and fetches new days afresh', async () => {
    const cached = buildInsightsApp({ clickhouse: readClickhouse, logger, publicKey: keys.publicKey, metricsCacheMs: 15_000 })
    const campaignId = randomUUID()
    const clicks = (query = '') => request(cached).get(`/api/v1/ad/${campaignId}/clicks${query}`).set('Authorization', reader)
    await insert([{ campaign_id: campaignId, event_name: 'click' }])
    expect((await clicks()).body.count).toBe(1)

    await insert([{ campaign_id: campaignId, event_name: 'click' }])
    // Within 15 s: the same answer, without asking ClickHouse.
    expect((await clicks()).body.count).toBe(1)
    // Other days are another entry. The app without a cache sees the new click at once.
    expect((await clicks(`?from=${midnight(1).toISOString()}`)).body.count).toBe(2)
    expect((await metric(campaignId, 'clicks')).body.count).toBe(2)
  })
})

describe('sellers', () => {
  it("shows a seller-manager only its own seller's campaigns, and a seller's totals across them", async () => {
    const [mine, other] = [randomUUID(), randomUUID()]
    const [first, second, theirs] = [randomUUID(), randomUUID(), randomUUID()]
    for (const [campaignId, sellerId] of [[first, mine], [second, mine], [theirs, other]] as const) await insertCampaign(campaignId, sellerId)
    const [alice, bob] = [randomUUID(), randomUUID()]
    await insert([
      { event_name: 'click', campaign_id: first, user_id: alice },
      { event_name: 'click', campaign_id: second, user_id: alice },
      { event_name: 'click', campaign_id: second, user_id: bob },
      { event_name: 'click', campaign_id: theirs, user_id: bob },
    ])
    const sellerManager = (await tokenFor(keys, 'seller-manager', { tid: TENANT, sel: mine })).header
    const sellerTotals = (sellerId: string, auth: string) => request(app).get(`/api/v1/ad/sellers/${sellerId}/clicks`).set('Authorization', auth)

    expect((await metric(first, 'clicks', '', sellerManager)).body.count).toBe(1)
    // Another seller's campaign doesn't exist for it.
    expect((await metric(theirs, 'clicks', '', sellerManager)).status).toBe(404)
    // Its totals: both of its campaigns, Alice counted once among the customers.
    expect((await sellerTotals(mine, sellerManager)).body).toMatchObject({ sellerId: mine, campaigns: 2, count: 3, customers: 2 })
    expect((await sellerTotals(other, sellerManager)).status).toBe(403)
    // The retailer's campaign managers see every seller.
    expect((await sellerTotals(other, reader)).body).toMatchObject({ campaigns: 1, count: 1 })
  })
})
