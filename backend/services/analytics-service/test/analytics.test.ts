import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogger, createMemoryEventBus, type EventBus, type MemoryEventBus } from '@ecommerce-analytics/platform'
import { createTestKeys, tokenFor, visitorTokenFor, type TestKeys } from '@ecommerce-analytics/platform/testing'
import { buildAnalyticsApp } from '../src/app.ts'
import { createClickHouse, type ClickHouse } from '../src/clickhouse.ts'
import { handleCampaignEvent } from '../src/events/campaign.consumer.ts'

const CLICKHOUSE = process.env.TEST_CLICKHOUSE_URL ?? 'http://ecommerce_analytics:ecommerce_analytics_dev@localhost:8123'
const HOUR = 3_600_000
const TENANT = '10000000-0000-4000-8000-000000000001'
const OTHER_TENANT = '20000000-0000-4000-8000-000000000002'
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const logger = createLogger('analytics-test')

let keys: TestKeys
/** A campaign manager of TENANT. */
let reader: string
/** An anonymous visitor of TENANT. */
let visitor: string
let database: string
let admin: ClickHouse
let clickhouse: ClickHouse
let bus: MemoryEventBus
let app: ReturnType<typeof buildAnalyticsApp>

/** A throwaway ClickHouse database with the real schema (infra/clickhouse/init.sql). */
async function createTestClickHouse() {
  database = `analytics_test_${randomUUID().replaceAll('-', '')}`
  admin = createClickHouse(CLICKHOUSE)
  const schema = readFileSync(path.join(import.meta.dirname, '../../../infra/clickhouse/init.sql'), 'utf8')
    .replace(/--.*$/gm, '')
    .replaceAll(/\banalytics\b/g, database)
  for (const statement of schema.split(';').map((s) => s.trim()).filter(Boolean)) await admin.command({ query: statement })
  return createClickHouse(`${CLICKHOUSE}/${database}`)
}

beforeAll(async () => {
  keys = await createTestKeys()
  reader = (await tokenFor(keys, 'campaign-manager', { tid: TENANT })).header
  visitor = (await visitorTokenFor(keys, TENANT)).header
  clickhouse = await createTestClickHouse()
  bus = createMemoryEventBus(logger)
  app = buildAnalyticsApp({ bus, clickhouse, logger, publicKey: keys.publicKey })
})

afterAll(async () => {
  await clickhouse.close()
  await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` })
  await admin.close()
})

interface TestEvent {
  eventId?: string
  campaignId?: string
  eventName: string
  productId?: string
  attributionId?: string
  timestamp?: string
  [key: string]: unknown
}

const send = (events: TestEvent[], auth = visitor, target = app) =>
  request(target)
    .post('/api/v1/analytics/events')
    .set('Authorization', auth)
    .send({ events: events.map((e) => ({ eventId: randomUUID(), timestamp: ago(60_000), ...e })) })

/** Applies a campaign.v1 event, as the Kafka consumer does. */
function campaignEvent(campaignId: string, version: number, state: { status?: string; archived?: boolean; tenantId?: string } = {}) {
  const payload = { campaignId, tenantId: TENANT, title: 'Sale', type: 'banner', status: 'active', startTime: null, endTime: null, archived: false, updatedAt: new Date().toISOString(), ...state }
  return handleCampaignEvent(clickhouse, {
    eventId: randomUUID(),
    eventType: version === 1 ? 'CampaignCreated' : 'CampaignUpdated',
    eventVersion: 1,
    occurredAt: payload.updatedAt,
    producer: 'campaign-service',
    aggregateId: campaignId,
    aggregateVersion: version,
    payload,
  })
}

async function activeCampaign() {
  const campaignId = randomUUID()
  await campaignEvent(campaignId, 1)
  return campaignId
}

describe('ingestion: publish to the topic for each event type', () => {
  it('publishes every accepted event to analytics.<eventName>.v1 with the full payload', async () => {
    const before = bus.published.length
    const campaignId = await activeCampaign()
    const productId = randomUUID()
    const clickId = randomUUID()
    const res = await send([
      { campaignId, eventName: 'impression', properties: { position: 1 } },
      { eventId: clickId, campaignId, productId, eventName: 'click', pageName: 'home', featureName: 'product_card' },
      { campaignId, productId, eventName: 'click_to_basket', attributionId: clickId },
      // Activity without a campaign is fine.
      { productId, eventName: 'add_to_cart', properties: { quantity: 1, source: 'catalog_grid' } },
      { eventName: 'cart_view', pageName: 'cart' },
    ])
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ accepted: 5, rejected: 0 })

    const published = bus.published.slice(before)
    expect(published.map((m) => m.topic)).toEqual([
      'analytics.impression.v1',
      'analytics.click.v1',
      'analytics.click_to_basket.v1',
      'analytics.add_to_cart.v1',
      'analytics.cart_view.v1',
    ])
    const click = published[1]!
    expect(click.key).toBe(clickId)
    expect(click.envelope).toMatchObject({ eventId: clickId, eventType: 'AnalyticsEventRecorded', producer: 'analytics-service' })
    expect(click.envelope.payload).toEqual({
      eventId: clickId,
      eventName: 'click',
      campaignId,
      productId,
      userId: null,
      tenantId: TENANT,
      pageName: 'home',
      featureName: 'product_card',
      attributionId: null,
      properties: {},
      timestamp: expect.any(String),
      receivedAt: expect.any(String),
    })
    expect(published[3]!.envelope.payload).toMatchObject({ campaignId: null, properties: { quantity: 1, source: 'catalog_grid' } })
  })

  it('takes the tenant and user from the token, never from headers or the body', async () => {
    const { header, sub, tid } = await tokenFor(keys, 'standard-user')
    const before = bus.published.length
    await send([{ eventName: 'home_view' }], header)
    expect(bus.published[before]!.envelope.payload).toMatchObject({ userId: sub, tenantId: tid })
    // A visitor has no user; a tenant_id header can't move its events to another tenant.
    await request(app)
      .post('/api/v1/analytics/events')
      .set('Authorization', visitor)
      .set('tenant_id', OTHER_TENANT)
      .send({ events: [{ eventId: randomUUID(), eventName: 'home_view', timestamp: ago(1_000) }] })
    expect(bus.published[before + 1]!.envelope.payload).toMatchObject({ userId: null, tenantId: TENANT })

    const spoofed = await send([{ eventName: 'home_view', userId: randomUUID() }])
    expect(spoofed.status).toBe(400)
    expect(spoofed.body.error.details.errors).toContain('events[0]: unknown field "userId"')
  })

  it('requires an access or visitor token', async () => {
    const event = { eventId: randomUUID(), eventName: 'home_view', timestamp: ago(1_000) }
    expect((await request(app).post('/api/v1/analytics/events').send({ events: [event] })).status).toBe(401)
    const foreign = (await visitorTokenFor(await createTestKeys())).header
    expect((await send([event], foreign)).status).toBe(401)
  })

  it("accepts metric events only for an active, unarchived campaign of the sender's tenant", async () => {
    const active = await activeCampaign()
    const [paused, archived, laterActive, otherTenants, noTenant] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    await campaignEvent(paused, 1)
    await campaignEvent(paused, 2, { status: 'paused' })
    await campaignEvent(archived, 1)
    await campaignEvent(archived, 2, { archived: true })
    // Versions decide, not arrival order: the older event arrives last.
    await campaignEvent(laterActive, 2)
    await campaignEvent(laterActive, 1, { status: 'draft' })
    await campaignEvent(otherTenants, 1, { tenantId: OTHER_TENANT })
    // An event from before campaigns had tenants is ignored.
    await campaignEvent(noTenant, 1, { tenantId: undefined })
    const res = await send([
      { campaignId: active, eventName: 'impression' },
      { campaignId: paused, eventName: 'impression' },
      { campaignId: archived, eventName: 'click' },
      { campaignId: randomUUID(), eventName: 'click' },
      { campaignId: laterActive, eventName: 'click' },
      { campaignId: otherTenants, eventName: 'impression' },
      { campaignId: noTenant, eventName: 'impression' },
      // Storefront activity is stored whatever the campaign.
      { campaignId: randomUUID(), eventName: 'campaign_navigation' },
    ])
    expect(res.body.results.map((r: { reason?: string }) => r.reason ?? 'accepted')).toEqual([
      'accepted',
      'CAMPAIGN_NOT_ACTIVE',
      'CAMPAIGN_NOT_ACTIVE',
      'CAMPAIGN_NOT_ACTIVE',
      'accepted',
      'CAMPAIGN_NOT_ACTIVE',
      'CAMPAIGN_NOT_ACTIVE',
      'accepted',
    ])
    expect((await send([{ campaignId: otherTenants, eventName: 'impression' }], (await visitorTokenFor(keys, OTHER_TENANT)).header)).body.accepted).toBe(1)
  })

  it('caps the events one sender can send per minute', async () => {
    const capped = buildAnalyticsApp({ bus, clickhouse, logger, publicKey: keys.publicKey, maxEventsPerMinute: 3 })
    const token = (await visitorTokenFor(keys, TENANT)).header
    expect((await send([{ eventName: 'home_view' }, { eventName: 'home_view' }], token, capped)).status).toBe(200)
    const over = await send([{ eventName: 'home_view' }, { eventName: 'home_view' }], token, capped)
    expect(over.status).toBe(429)
    expect(over.body.error.code).toBe('TOO_MANY_EVENTS')
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)
    // Other senders have their own allowance.
    expect((await send([{ eventName: 'home_view' }], visitor, capped)).status).toBe(200)
  })

  it('rejects malformed batches, and events outside the time window without publishing them', async () => {
    const malformed = await request(app)
      .post('/api/v1/analytics/events')
      .set('Authorization', visitor)
      .send({ events: [{ eventId: 'x', eventName: 'purchase', timestamp: 'now' }] })
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.details.errors).toEqual(
      expect.arrayContaining(['events[0].eventId must be a UUID', 'events[0].timestamp must be an ISO 8601 date-time']),
    )
    expect((await send([{ eventName: 'click' }])).body.error.details.errors).toEqual(['events[0].campaignId must be a UUID'])
    expect((await send([{ campaignId: randomUUID(), eventName: 'click_to_basket', productId: randomUUID() }])).status).toBe(400)
    expect((await request(app).post('/api/v1/analytics/events').set('Authorization', visitor).send({ events: [] })).status).toBe(400)

    const before = bus.published.length
    const res = await send([
      { eventName: 'home_view', timestamp: ago(6 * 24 * HOUR) },
      { eventName: 'home_view', timestamp: new Date(Date.now() + HOUR).toISOString() },
      { eventName: 'home_view' },
    ])
    expect(res.body).toMatchObject({ accepted: 1, rejected: 2 })
    expect(res.body.results.map((r: { reason?: string }) => r.reason)).toEqual(['TIMESTAMP_OUT_OF_RANGE', 'TIMESTAMP_OUT_OF_RANGE', undefined])
    expect(bus.published.length - before).toBe(1)
  })

  it('answers 503 when Kafka is unavailable, so the client knows nothing was recorded', async () => {
    const broken: EventBus = { ...bus, publish: () => Promise.reject(new Error('broker down')) }
    const brokenApp = buildAnalyticsApp({ bus: broken, clickhouse, logger, publicKey: keys.publicKey })
    const res = await send([{ eventName: 'home_view' }], undefined, brokenApp)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('EVENTS_NOT_DELIVERED')
  })
})

/** Rows as the Spark job writes them. */
interface Row {
  event_id?: string
  event_name: string
  campaign_id?: string | null
  product_id?: string | null
  user_id?: string | null
  tenant_id?: string
  attribution_id?: string | null
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
      event_time: ago(60_000),
      received_at: new Date().toISOString(),
      properties: '{}',
      ...row,
    })),
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
    // "from" snaps down to midnight; "to" falls today, so it stays.
    const snapped = new Date(Math.floor(new Date(from).getTime() / (24 * HOUR)) * 24 * HOUR).toISOString()
    expect((await metric(campaignId, 'clicks', `?from=${from}&to=${to}`)).body).toMatchObject({ count: 1, period: { from: snapped, to } })
    expect((await metric(campaignId, 'clicks', `?from=${new Date().toISOString()}&to=${ago(HOUR)}`)).body.error.code).toBe('INVALID_PERIOD')
    expect((await metric(campaignId, 'clicks', '?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z')).body.error.code).toBe('INVALID_PERIOD')
    expect((await metric(campaignId, 'clicks', '?from=yesterday')).status).toBe(400)
  })

  it('counts only basket additions credited to a valid earlier click', async () => {
    const campaignId = randomUUID()
    const other = randomUUID()
    const [product, otherProduct] = [randomUUID(), randomUUID()]
    const [shopper, someoneElse] = [randomUUID(), randomUUID()]
    const click = randomUUID()
    const oldClick = randomUUID()
    const userClick = randomUUID()
    const basket = (attribution_id: string, extra: Partial<Row> = {}): Row => ({
      event_name: 'click_to_basket',
      campaign_id: campaignId,
      product_id: product,
      attribution_id,
      ...extra,
    })
    await insert([
      { event_id: click, event_name: 'click', campaign_id: campaignId, product_id: product, event_time: ago(2 * HOUR) },
      { event_id: oldClick, event_name: 'click', campaign_id: campaignId, product_id: product, event_time: ago(30 * HOUR) },
      { event_id: userClick, event_name: 'click', campaign_id: campaignId, product_id: product, user_id: shopper, event_time: ago(2 * HOUR) },
      basket(click), // ✓
      basket(click), // same click and product again: credited once
      basket(randomUUID()), // no such click
      basket(click, { product_id: otherProduct }), // the click was for another product
      basket(click, { campaign_id: other }), // another campaign
      basket(click, { event_time: ago(3 * HOUR) }), // before the click
      basket(oldClick), // more than 24 hours after the click
      basket(userClick, { user_id: someoneElse }), // a different signed-in user
      basket(userClick, { user_id: shopper }), // ✓
    ])
    expect((await metric(campaignId, 'clickToBasket')).body.count).toBe(2)
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

/** What runs every hour: find the changed days, then recount them. */
async function runDailyJob() {
  for (const view of ['campaign_daily_changes_mv', 'campaign_daily_aggregates_mv']) {
    await admin.command({ query: `SYSTEM REFRESH VIEW ${database}.${view}` })
    await admin.command({ query: `SYSTEM WAIT VIEW ${database}.${view}` })
  }
}

async function savedAggregates(campaignId: string) {
  const result = await clickhouse.query({
    query: `SELECT toString(day) AS day, tenant_id, total_ad_impressions, total_ad_clicks, total_click_to_basket
            FROM campaign_daily_aggregates WHERE campaign_id = {campaignId:UUID} ORDER BY toString(tenant_id), day`,
    query_params: { campaignId },
    format: 'JSONEachRow',
    clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
  })
  return result.json()
}

describe('the aggregates job', () => {
  it('saves days per tenant and campaign, by the /ad counting rules', async () => {
    const campaignId = randomUUID()
    const product = randomUUID()
    const duplicate = randomUUID()
    const [click, earlierClick, lateClick] = [randomUUID(), randomUUID(), randomUUID()]
    const basket = (attribution_id: string, event_time: string): Row => ({
      event_name: 'click_to_basket',
      campaign_id: campaignId,
      product_id: product,
      attribution_id,
      event_time,
    })
    await insert([
      { campaign_id: campaignId, event_name: 'impression', event_time: atDay(1, 10) },
      { campaign_id: campaignId, event_name: 'impression', event_id: duplicate, event_time: atDay(1, 10) },
      { campaign_id: campaignId, event_name: 'impression', event_id: duplicate, event_time: atDay(1, 10) },
      { event_id: click, event_name: 'click', campaign_id: campaignId, product_id: product, event_time: atDay(1, 9) },
      basket(click, atDay(1, 10)),
      basket(click, atDay(1, 11)), // same click and product: once
      basket(randomUUID(), atDay(1, 10)), // no such click
      { event_id: earlierClick, event_name: 'click', campaign_id: campaignId, product_id: product, event_time: atDay(2, 22) },
      basket(earlierClick, atDay(1, 1)), // credited to the click from the day before
      basket(lateClick, atDay(1, 12)), // its click is stored after the basket
      { campaign_id: campaignId, event_name: 'click', tenant_id: OTHER_TENANT, event_time: atDay(1, 11) },
      { campaign_id: campaignId, event_name: 'impression', event_time: atDay(0, 0) }, // today: saved too
    ])
    await insert([{ event_id: lateClick, event_name: 'click', campaign_id: campaignId, product_id: product, event_time: atDay(1, 11) }])
    await runDailyJob()
    await insert([{ campaign_id: campaignId, event_name: 'impression', event_time: atDay(1, 15) }])
    await runDailyJob() // recounts yesterday: still one row per key, now with the extra impression

    expect(await savedAggregates(campaignId)).toEqual([
      { day: dayString(2), tenant_id: TENANT, total_ad_impressions: 0, total_ad_clicks: 1, total_click_to_basket: 0 },
      { day: dayString(1), tenant_id: TENANT, total_ad_impressions: 3, total_ad_clicks: 2, total_click_to_basket: 3 },
      { day: dayString(0), tenant_id: TENANT, total_ad_impressions: 1, total_ad_clicks: 0, total_click_to_basket: 0 },
      { day: dayString(1), tenant_id: OTHER_TENANT, total_ad_impressions: 0, total_ad_clicks: 1, total_click_to_basket: 0 },
    ])
    // (tenant_id, campaign_id, day) is unique across the whole table, without FINAL.
    const duplicates = await clickhouse.query({
      query: 'SELECT count() - uniqExact(tenant_id, campaign_id, day) AS duplicates FROM campaign_daily_aggregates',
      format: 'JSONEachRow',
      clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
    })
    expect(await duplicates.json()).toEqual([{ duplicates: 0 }])
  })
})

describe('/ad combines saved days with raw events for yesterday and today', () => {
  it('reads days before yesterday from the aggregates, which take in late events on the next run', async () => {
    const campaignId = randomUUID()
    await insert([
      { campaign_id: campaignId, event_name: 'click', event_time: atDay(3, 12) },
      { campaign_id: campaignId, event_name: 'click', event_time: atDay(1, 12) },
      { campaign_id: campaignId, event_name: 'click', event_time: ago(1_000) },
    ])
    await runDailyJob()
    expect((await metric(campaignId, 'clicks')).body.count).toBe(3)

    // A late click for 3 days ago: stored now, counted once the job has run again.
    await insert([{ campaign_id: campaignId, event_name: 'click', event_time: atDay(3, 13) }])
    expect((await metric(campaignId, 'clicks')).body.count).toBe(3)
    await runDailyJob()
    expect((await metric(campaignId, 'clicks')).body.count).toBe(4)
    expect(await savedAggregates(campaignId)).toEqual([
      { day: dayString(3), tenant_id: TENANT, total_ad_impressions: 0, total_ad_clicks: 2, total_click_to_basket: 0 },
      { day: dayString(1), tenant_id: TENANT, total_ad_impressions: 0, total_ad_clicks: 1, total_click_to_basket: 0 },
      { day: dayString(0), tenant_id: TENANT, total_ad_impressions: 0, total_ad_clicks: 1, total_click_to_basket: 0 },
    ])

    // Yesterday and today only: raw events.
    expect((await metric(campaignId, 'clicks', `?from=${midnight(1).toISOString()}`)).body.count).toBe(2)
    // Snapped to whole days: [3 days ago 00:00, 2 days ago 00:00).
    const saved = await metric(campaignId, 'clicks', `?from=${atDay(3, 18)}&to=${atDay(3, 20)}`)
    expect(saved.body).toMatchObject({ count: 2, period: { from: midnight(3).toISOString(), to: midnight(2).toISOString() } })
  })

  it("saves today's rows on the next run, so a later run's watermark can't skip them", async () => {
    // The old job left today's rows for after midnight; a run that saved a late event
    // for an older day meanwhile moved max(computed_at) past them, so they were never counted.
    const campaignId = randomUUID()
    await insert([{ campaign_id: campaignId, event_name: 'click', event_time: ago(60_000) }])
    await runDailyJob()
    await insert([{ campaign_id: randomUUID(), event_name: 'click', event_time: atDay(3, 12) }])
    await runDailyJob()
    expect(await savedAggregates(campaignId)).toEqual([
      { day: dayString(0), tenant_id: TENANT, total_ad_impressions: 0, total_ad_clicks: 1, total_click_to_basket: 0 },
    ])
  })
})
