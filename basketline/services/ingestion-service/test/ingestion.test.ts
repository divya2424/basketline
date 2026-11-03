import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CAMPAIGN_PRODUCTS_TOPIC, CAMPAIGN_TOPIC, CATALOG_TOPIC, externalId, IDENTITY_TOPIC, INTERACTIONS_TOPIC, NO_STORE } from '@basketline/contracts'
import { CALLER_HEADER, createLogger, createMemoryEventBus, type EventBus, type MemoryEventBus, type Sender } from '@basketline/platform'
import type { ClickHouse } from '@basketline/platform/clickhouse'
import { createTestClickHouse } from '@basketline/platform/testing'
import { buildIngestionApp } from '../src/app.ts'
import { ANY_CAMPAIGN, createCampaignDirectory } from '../src/services/campaign.directory.ts'
import { handleIdentityEvent } from '../src/events/identity.consumer.ts'
import { handleTenantEvent } from '../src/events/tenant.consumer.ts'

const HOUR = 3_600_000
const TENANT = '10000000-0000-4000-8000-000000000001'
const OTHER_TENANT = '20000000-0000-4000-8000-000000000002'
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const logger = createLogger('ingestion-test')

/**
 * A sender as the gateway passes it on (CALLER_HEADER), having verified its
 * access, visitor or shopper token; a visitor of the tenant unless set.
 */
const callerOf = (tenantId: string, sender: Partial<Sender> = {}) =>
  JSON.stringify({ tenantId, userId: randomUUID(), userType: 'visitor', clientType: 'web', tier: null, ...sender })

const visitorId = randomUUID()
/** A visitor of TENANT. */
const visitor = callerOf(TENANT, { userId: visitorId })
let db: Awaited<ReturnType<typeof createTestClickHouse>>
let clickhouse: ClickHouse
let bus: MemoryEventBus
let app: ReturnType<typeof buildIngestionApp>

beforeAll(async () => {
  db = await createTestClickHouse()
  clickhouse = db.clickhouse
  bus = createMemoryEventBus(logger)
  app = buildIngestionApp({ bus, clickhouse, logger, campaigns: ANY_CAMPAIGN })
})

afterAll(async () => {
  await db.drop()
})

interface TestEvent {
  eventId?: string
  campaignId?: string
  eventName: string
  productId?: string
  timestamp?: string
  [key: string]: unknown
}

/** The identity a client sends with a batch: the one its token was issued for. */
function identityOf(caller: string) {
  const { tenantId, userId, userType } = JSON.parse(caller) as Sender
  return { tenantId, userId, userType }
}

/** As a client sends them: campaignId and productId go inside properties. */
const toWire = ({ campaignId, productId, properties, ...event }: TestEvent) => ({
  eventId: randomUUID(),
  timestamp: ago(60_000),
  ...event,
  ...(campaignId === undefined && productId === undefined && properties === undefined
    ? {}
    : { properties: { ...(campaignId === undefined ? {} : { campaignId }), ...(productId === undefined ? {} : { productId }), ...(properties as object) } }),
})

const send = (events: TestEvent[], auth = visitor, target = app, identity: object = identityOf(auth)) =>
  request(target)
    .post('/api/v1/analytics/events')
    .set(CALLER_HEADER, auth)
    .send({ ...identity, events: events.map(toWire) })

describe('ingestion: publish to the topic for each event type', () => {
  it("rejects a declared bot's batch as invalid traffic, and publishes none of it", async () => {
    const before = bus.published.length
    const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
    const res = await send([{ eventName: 'home_view' }, { eventName: 'cart_view' }]).set('User-Agent', googlebot)
    expect(res.body).toMatchObject({ accepted: 0, rejected: 2, results: [{ reason: 'INVALID_TRAFFIC' }, { reason: 'INVALID_TRAFFIC' }] })
    expect(bus.published.length).toBe(before)

    // A browser is not a bot.
    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    expect((await send([{ eventName: 'home_view' }]).set('User-Agent', chrome)).body).toMatchObject({ accepted: 1 })
  })

  it('publishes IDs in lowercase, whatever case the client sent them in', async () => {
    const before = bus.published.length
    const [eventId, campaignId, productId] = [randomUUID(), randomUUID(), randomUUID()]
    const res = await send([{ eventId: eventId.toUpperCase(), campaignId: campaignId.toUpperCase(), productId: productId.toUpperCase(), eventName: 'click' }])
    expect(res.body).toMatchObject({ accepted: 1 })
    const [message] = bus.published.slice(before)
    expect(message!.key).toBe(eventId)
    expect(message!.envelope).toMatchObject({ eventId, aggregateId: eventId, payload: { eventId, campaignId, productId } })
  })

  it('publishes every accepted event to the interactions topic with the full payload', async () => {
    const before = bus.published.length
    const [campaignId, productId, clickId] = [randomUUID(), randomUUID(), randomUUID()]
    const res = await send([
      { campaignId, eventName: 'impression', properties: { position: 1 } },
      { eventId: clickId, campaignId, productId, eventName: 'click', pageName: 'home', featureName: 'product_card' },
      // Activity without a campaign is fine. The Flink job credits this basket
      // addition to the click above; the client sends no link between them.
      { productId, eventName: 'add_to_cart', properties: { quantity: 1, source: 'catalog_grid' } },
      { eventName: 'cart_view', pageName: 'cart' },
    ])
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ accepted: 4, rejected: 0 })

    const published = bus.published.slice(before)
    // One shared topic, whatever the event name; the name is in the payload.
    expect(published.map((m) => m.topic)).toEqual(Array(4).fill(INTERACTIONS_TOPIC))
    expect(published.map((m) => m.envelope.payload)).toMatchObject([{ eventName: 'impression' }, { eventName: 'click' }, { eventName: 'add_to_cart' }, { eventName: 'cart_view' }])
    const click = published[1]!
    expect(click.key).toBe(clickId)
    expect(click.envelope).toMatchObject({ eventId: clickId, eventType: 'AnalyticsEventRecorded', producer: 'ingestion-service' })
    expect(click.envelope.payload).toEqual({
      eventId: clickId,
      eventType: 'interaction',
      eventName: 'click',
      campaignId,
      productId,
      // The batch named no store.
      storeId: NO_STORE,
      userId: visitorId,
      userType: 'visitor',
      clientType: 'web',
      tenantId: TENANT,
      pageName: 'home',
      featureName: 'product_card',
      properties: {},
      timestamp: expect.any(String),
      receivedAt: expect.any(String),
    })
    expect(published[2]!.envelope.payload).toMatchObject({ campaignId: null, properties: { quantity: 1, source: 'catalog_grid' } })
  })

  it('takes the tenant, user and client type from the token', async () => {
    const sub = randomUUID()
    const tid = randomUUID()
    const header = callerOf(tid, { userId: sub, userType: 'registered', clientType: 'mobile' })
    const before = bus.published.length
    await send([{ eventName: 'home_view' }], header)
    expect(bus.published[before]!.envelope.payload).toMatchObject({ userId: sub, userType: 'registered', tenantId: tid, clientType: 'mobile' })
    await send([{ eventName: 'home_view' }])
    expect(bus.published[before + 1]!.envelope.payload).toMatchObject({ userId: visitorId, userType: 'visitor', tenantId: TENANT, clientType: 'web' })

    const spoofed = await send([{ eventName: 'home_view', userId: randomUUID() }])
    expect(spoofed.status).toBe(400)
    expect(spoofed.body.error.details.errors).toContain('events[0]: unknown field "userId"')
  })

  it("rejects the whole batch when the tenant, user or user type sent don't match the token", async () => {
    const userId = randomUUID()
    const user = { sub: userId, header: callerOf(TENANT, { userId, userType: 'registered' }) }
    const before = bus.published.length
    const mismatches = [
      send([{ eventName: 'home_view' }], visitor, app, { tenantId: OTHER_TENANT, userId: visitorId, userType: 'visitor' }),
      send([{ eventName: 'home_view' }], visitor, app, { tenantId: TENANT, userId: randomUUID(), userType: 'visitor' }),
      // A visitor claiming to be registered or to be a user, and a user claiming another user or to be a visitor.
      send([{ eventName: 'home_view' }], visitor, app, { tenantId: TENANT, userId: visitorId, userType: 'registered' }),
      send([{ eventName: 'home_view' }], visitor, app, { tenantId: TENANT, userId: user.sub, userType: 'registered' }),
      send([{ eventName: 'home_view' }], user.header, app, { tenantId: TENANT, userId: randomUUID(), userType: 'registered' }),
      send([{ eventName: 'home_view' }], user.header, app, { tenantId: TENANT, userId: user.sub, userType: 'visitor' }),
      // The body matches, but the tenant_id header names another tenant.
      send([{ eventName: 'home_view' }], visitor).set('tenant_id', OTHER_TENANT),
    ]
    for (const res of await Promise.all(mismatches)) {
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('IDENTITY_MISMATCH')
    }
    expect(bus.published.length).toBe(before)

    expect((await send([{ eventName: 'home_view' }], visitor).set('tenant_id', TENANT)).status).toBe(200)
    expect((await send([{ eventName: 'home_view' }], visitor, app, {})).body.error.details.errors).toEqual(
      expect.arrayContaining(['tenantId must be a UUID', 'userId must be a UUID', 'userType must be one of visitor, registered']),
    )
  })

  it('requires the sender the gateway verified', async () => {
    const event = { eventId: randomUUID(), eventName: 'home_view', timestamp: ago(1_000) }
    expect((await request(app).post('/api/v1/analytics/events').send({ events: [event] })).status).toBe(401)
    expect((await send([event], 'not json', app, identityOf(visitor))).status).toBe(401)
    // A tenant without a sender (an integration token's) can't send events.
    expect((await send([event], JSON.stringify({ tenantId: TENANT }), app, identityOf(visitor))).status).toBe(401)
  })

  it("counts impressions and clicks only for the tenant's active campaigns, and counts each outcome for the alerts", async () => {
    const [active, paused, removed, othersCampaign, startedJustNow] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const campaign = (campaign_id: string, status: string, tenant_id = TENANT) => ({ tenant_id, campaign_id, status, archived: false, updated_at: ago(HOUR) })
    const record = (rows: object[]) => clickhouse.insert({ table: 'campaigns', values: rows, format: 'JSONEachRow', clickhouse_settings: { date_time_input_format: 'best_effort' } })
    await record([campaign(active, 'active'), campaign(paused, 'paused'), campaign(removed, 'removed'), campaign(othersCampaign, 'active', OTHER_TENANT)])
    // missMs 0: a campaign the cache doesn't know reloads the tenant's at once.
    const checked = buildIngestionApp({ bus, clickhouse, logger, campaigns: createCampaignDirectory({ clickhouse, logger, missMs: 0 }) })

    const res = await send(
      [
        { campaignId: active, eventName: 'impression' },
        { campaignId: active, eventName: 'click' },
        { campaignId: paused, eventName: 'impression' },
        { campaignId: removed, eventName: 'click' },
        { campaignId: othersCampaign, eventName: 'impression' },
        // Other activity names a campaign or not, unchecked.
        { campaignId: randomUUID(), eventName: 'product_click' },
      ],
      visitor,
      checked,
    )
    expect(res.body).toMatchObject({ accepted: 3, rejected: 3 })
    expect(res.body.results.filter((r: { status: string }) => r.status === 'rejected').map((r: { reason: string }) => r.reason)).toEqual(['UNKNOWN_CAMPAIGN', 'UNKNOWN_CAMPAIGN', 'UNKNOWN_CAMPAIGN'])

    // A campaign created a moment ago counts as soon as ClickHouse has it.
    await record([campaign(startedJustNow, 'active')])
    expect((await send([{ campaignId: startedJustNow, eventName: 'impression' }], visitor, checked)).body).toMatchObject({ accepted: 1 })

    const metrics = (await request(checked).get('/metrics')).text
    expect(metrics).toMatch(/ingestion_events_total\{outcome="rejected",reason="UNKNOWN_CAMPAIGN"[^}]*\} 3/)
    expect(metrics).toMatch(/ingestion_events_total\{outcome="accepted",reason=""[^}]*\} 4/)
  })

  it("accepts events unchecked when the tenant's campaigns can't be read: the check never stops ingestion", async () => {
    const down = { query: async () => { throw new Error('ClickHouse is down') } } as unknown as ClickHouse
    const unchecked = buildIngestionApp({ bus, clickhouse, logger, campaigns: createCampaignDirectory({ clickhouse: down, logger }) })
    expect((await send([{ campaignId: randomUUID(), eventName: 'click' }], visitor, unchecked)).body).toMatchObject({ accepted: 1, rejected: 0 })
  })

  it("publishes the batch's store with each event: the store's own ID mapped to a UUID (as a seller's), a UUID as is", async () => {
    const before = bus.published.length
    const uuid = randomUUID()
    const sendFrom = (storeId: unknown) => request(app).post('/api/v1/analytics/events').set(CALLER_HEADER, visitor).send({ ...identityOf(visitor), storeId, events: [toWire({ eventName: 'home_view' })] })
    expect((await sendFrom('web')).body).toMatchObject({ accepted: 1 })
    expect((await sendFrom(uuid.toUpperCase())).body).toMatchObject({ accepted: 1 })
    expect(bus.published.slice(before).map((m) => (m.envelope.payload as { storeId: string }).storeId)).toEqual([externalId(TENANT, 'seller', 'web'), uuid])
    const bad = await sendFrom('not a store id!')
    expect(bad.status).toBe(400)
    expect(bad.body.error.details.errors).toEqual([expect.stringContaining('storeId')])
  })

  it('caps the events one sender can send per minute', async () => {
    const capped = buildIngestionApp({ bus, clickhouse, logger, campaigns: ANY_CAMPAIGN, maxEventsPerMinute: 3 })
    const token = callerOf(TENANT)
    expect((await send([{ eventName: 'home_view' }, { eventName: 'home_view' }], token, capped)).status).toBe(200)
    const over = await send([{ eventName: 'home_view' }, { eventName: 'home_view' }], token, capped)
    expect(over.status).toBe(429)
    expect(over.body.error.code).toBe('TOO_MANY_EVENTS')
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)
    // Other senders have their own allowance.
    expect((await send([{ eventName: 'home_view' }], visitor, capped)).status).toBe(200)
  })

  it("holds a busy tenant to its tier's budget, across its senders, while other tenants' events keep flowing", async () => {
    const budgeted = buildIngestionApp({ bus, clickhouse, logger, campaigns: ANY_CAMPAIGN, tenantEventsPerMinute: { free: 3, pro: 6, enterprise: 100 } })
    const busy = randomUUID()
    const pro = randomUUID()
    // The tier is in the visitor or shopper token; a token without one counts as free.
    const proVisitor = callerOf(pro, { tier: 'pro' })
    const two = [{ eventName: 'home_view' }, { eventName: 'home_view' }] as const

    expect((await send([...two], callerOf(busy), budgeted)).status).toBe(200)
    // Another of the same tenant's visitors: the budget is the tenant's, not the sender's.
    const over = await send([...two], callerOf(busy), budgeted)
    expect(over.status).toBe(429)
    expect(over.body.error.code).toBe('TENANT_RATE_LIMITED')
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)

    expect((await send([{ eventName: 'home_view' }], callerOf(OTHER_TENANT), budgeted)).status).toBe(200)
    expect((await send([...two, ...two], proVisitor, budgeted)).status).toBe(200)
  })

  it('rejects malformed batches, and events outside the time window without publishing them', async () => {
    const malformed = await request(app)
      .post('/api/v1/analytics/events')
      .set(CALLER_HEADER, visitor)
      .send({ ...identityOf(visitor), events: [{ eventId: 'x', eventName: 'purchase', timestamp: 'now' }] })
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.details.errors).toEqual(
      expect.arrayContaining(['events[0].eventId must be a UUID', 'events[0].timestamp must be an ISO 8601 date-time']),
    )
    expect((await send([{ eventName: 'click' }])).body.error.details.errors).toEqual(['events[0].properties.campaignId must be a campaign ID (a UUID or your own ID)'])
    // The IDs belong in properties, not at the top level of the event.
    const topLevel = { eventId: randomUUID(), timestamp: ago(60_000), eventName: 'click', campaignId: randomUUID(), productId: randomUUID() }
    expect((await request(app).post('/api/v1/analytics/events').set(CALLER_HEADER, visitor).send({ ...identityOf(visitor), events: [topLevel] })).body.error.details.errors).toEqual(
      expect.arrayContaining(['events[0]: unknown field "campaignId"', 'events[0]: unknown field "productId"']),
    )
    // Attribution is the platform's: no click_to_basket events, and no attributionId.
    expect((await send([{ campaignId: randomUUID(), eventName: 'click_to_basket', productId: randomUUID() }])).status).toBe(400)
    expect((await send([{ eventName: 'add_to_cart', productId: randomUUID(), attributionId: randomUUID() }])).body.error.details.errors).toEqual([
      'events[0]: unknown field "attributionId"',
    ])
    expect((await request(app).post('/api/v1/analytics/events').set(CALLER_HEADER, visitor).send({ ...identityOf(visitor), events: [] })).status).toBe(400)

    const before = bus.published.length
    const res = await send([
      // Older than 2 days: ClickHouse's staging (3 days) might no longer hold its day.
      { eventName: 'home_view', timestamp: ago(49 * HOUR) },
      { eventName: 'home_view', timestamp: new Date(Date.now() + HOUR).toISOString() },
      { eventName: 'home_view', timestamp: ago(47 * HOUR) },
      { eventName: 'home_view' },
    ])
    expect(res.body).toMatchObject({ accepted: 2, rejected: 2 })
    expect(res.body.results.map((r: { reason?: string }) => r.reason)).toEqual(['TIMESTAMP_OUT_OF_RANGE', 'TIMESTAMP_OUT_OF_RANGE', undefined, undefined])
    expect(bus.published.length - before).toBe(2)
  })

  it('answers 503 when Kafka is unavailable, so the client knows nothing was recorded', async () => {
    const broken: EventBus = { ...bus, publish: () => Promise.reject(new Error('broker down')) }
    const brokenApp = buildIngestionApp({ bus: broken, clickhouse, logger, campaigns: ANY_CAMPAIGN })
    const res = await send([{ eventName: 'home_view' }], undefined, brokenApp)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('EVENTS_NOT_DELIVERED')
  })
})

/** Rows as the Flink job writes them (through Kafka). */
interface Row {
  event_id?: string
  event_name: string
  campaign_id?: string
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
      store_id: NO_STORE,
      campaign_id: randomUUID(),
      user_type: 'visitor',
      client_type: 'web',
      event_time: ago(60_000),
      received_at: new Date().toISOString(),
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
        store_id: NO_STORE,
        product_id: randomUUID(),
        user_id: randomUUID(),
        user_type: 'visitor',
        client_type: 'web',
        event_time,
        click_time: event_time,
        ...row,
      }
    }),
  })
}

/** A user session as the Flink job writes it, with one campaign seen in no store (so the daily sessions view gets a row). */
async function insertSession({ tenant_id = TENANT, user_id = randomUUID() }: { tenant_id?: string; user_id?: string }) {
  await clickhouse.insert({
    table: 'sessions',
    format: 'JSONEachRow',
    clickhouse_settings: { date_time_input_format: 'best_effort' },
    values: [{ tenant_id, user_id, user_type: 'visitor', session_start: ago(HOUR), session_end: ago(HOUR / 2), events: 2, web: true, mobile: false,
               campaigns: [`${NO_STORE}:${randomUUID()}`], clicked: [], added: [] }],
  })
}

describe('a deleted tenant (TenantDeleted)', () => {
  it("deletes all of its analytics, keeps other tenants', and records it so Kafka replays can't bring it back", async () => {
    const gone = randomUUID()
    const campaignId = randomUUID()
    await insert([
      { campaign_id: campaignId, event_name: 'impression', user_id: randomUUID(), tenant_id: gone },
      { campaign_id: campaignId, event_name: 'click', user_id: randomUUID(), tenant_id: gone },
      { campaign_id: campaignId, event_name: 'impression', user_id: randomUUID() },
    ])
    await insertAttributed([{ click_event_id: randomUUID(), campaign_id: campaignId, tenant_id: gone }])
    await insertSession({ tenant_id: gone })
    await insertSession({})
    await clickhouse.insert({
      table: 'campaigns',
      values: [{ tenant_id: gone, campaign_id: campaignId, status: 'active', archived: false, updated_at: ago(HOUR) }, { tenant_id: TENANT, campaign_id: campaignId, status: 'active', archived: false, updated_at: ago(HOUR) }],
      format: 'JSONEachRow',
      clickhouse_settings: { date_time_input_format: 'best_effort' },
    })

    const count = async (table: string, tenant: string) =>
      Number((await (await clickhouse.query({ query: `SELECT count() AS n FROM ${table} WHERE tenant_id = {t:UUID}`, query_params: { t: tenant }, format: 'JSONEachRow' })).json<{ n: string }>())[0]!.n)
    const tables = ['events', 'attributed_baskets', 'sessions', 'daily_campaign_aggregation', 'daily_campaign_customers_aggregation', 'daily_campaign_sessions_aggregation', 'campaigns']
    for (const table of tables) expect(await count(table, gone), table).toBeGreaterThan(0)
    const othersBefore = await Promise.all(tables.map((table) => count(table, TENANT)))

    const envelope = { eventId: randomUUID(), eventType: 'TenantDeleted', eventVersion: 1, occurredAt: new Date().toISOString(), producer: 'auth-service', aggregateId: gone, aggregateVersion: 2, payload: { tenantId: gone, name: 'Gone Store', deletedAt: new Date().toISOString() } }
    await handleTenantEvent(clickhouse, envelope)
    await handleTenantEvent(clickhouse, envelope) // redelivered: harmless

    for (const table of tables) expect(await count(table, gone), table).toBe(0)
    expect(await Promise.all(tables.map((table) => count(table, TENANT)))).toEqual(othersBefore)
    // The data lake purge (airflow/dags/tenant_purge.py) is still to come.
    const recorded = await (await clickhouse.query({ query: 'SELECT name, lake_purged_at FROM deleted_tenants FINAL WHERE tenant_id = {t:UUID}', query_params: { t: gone }, format: 'JSONEachRow' })).json()
    expect(recorded).toEqual([{ name: 'Gone Store', lake_purged_at: null }])
  })
})

describe("a store's own IDs, its reference data and the event types", () => {
  /** A store's backend, as the gateway passes it on from its integration token. */
  const integration = (tenantId = TENANT) => JSON.stringify({ tenantId })
  const retail = (path: string, events: object[], auth: string) => request(app).post(`/api/v1/retail/${path}`).set(CALLER_HEADER, auth).send({ events })

  it("maps a store's own campaign and product IDs to UUIDs", async () => {
    const code = `SPRING-${randomUUID().slice(0, 8)}`
    const before = bus.published.length
    expect((await send([{ campaignId: code, productId: 'SKU-9', eventName: 'click' }])).body).toMatchObject({ accepted: 1 })
    expect(bus.published[before]!.envelope.payload).toMatchObject({
      eventType: 'interaction',
      campaignId: externalId(TENANT, 'campaign', code),
      productId: externalId(TENANT, 'product', 'SKU-9'),
    })
  })

  it('sends login activity to the identity topic, and refuses server-only identity events from a client', async () => {
    const before = bus.published.length
    expect((await send([{ eventName: 'login_click' }])).body).toMatchObject({ accepted: 1 })
    const [message] = bus.published.slice(before)
    expect(message!.topic).toBe(IDENTITY_TOPIC)
    expect(message!.envelope.payload).toMatchObject({ eventType: 'identity', eventName: 'login_click' })
    expect((await send([{ eventName: 'user_deleted' as never }])).status).toBe(400)
  })

  it("publishes each event's own store (its seller), over the batch's", async () => {
    const before = bus.published.length
    const res = await request(app)
      .post('/api/v1/analytics/events')
      .set(CALLER_HEADER, visitor)
      .send({ ...identityOf(visitor), storeId: 'web', events: [{ ...toWire({ eventName: 'impression', campaignId: 'C-1' }), storeId: 'acme' }, toWire({ eventName: 'home_view' })] })
    expect(res.body).toMatchObject({ accepted: 2 })
    expect(bus.published.slice(before).map((m) => (m.envelope.payload as { storeId: string }).storeId)).toEqual([externalId(TENANT, 'seller', 'acme'), externalId(TENANT, 'seller', 'web')])
    const bad = await request(app).post('/api/v1/analytics/events').set(CALLER_HEADER, visitor).send({ ...identityOf(visitor), events: [{ ...toWire({ eventName: 'home_view' }), storeId: 'no spaces' }] })
    expect(bad.status).toBe(400)
  })

  it("takes reference data only from the gateway's caller, mapping the store's IDs, its first-party seller, and a product's store to its seller", async () => {
    const product = [{ eventName: 'product_upserted', data: { productId: 'SKU-1', name: 'Trail shoe' } }]
    expect((await request(app).post('/api/v1/retail/catalog').send({ events: product })).status).toBe(401)
    expect((await retail('campaigns', [{ eventName: 'campaign_upserted', data: { campaignId: 'C-1', title: 'x', status: 'active', productIds: [] } }], integration())).status).toBe(400)

    const before = bus.published.length
    expect((await retail('catalog', product, integration())).status).toBe(202)
    const firstParty = externalId(TENANT, 'seller', 'first-party')
    const published = bus.published.slice(before)
    expect(published.every((m) => m.topic === CATALOG_TOPIC)).toBe(true)
    expect(published.map((m) => [m.envelope.eventType, m.envelope.payload])).toEqual([
      ['seller_upserted', expect.objectContaining({ sellerId: firstParty, tenantId: TENANT })],
      ['product_upserted', expect.objectContaining({ productId: externalId(TENANT, 'product', 'SKU-1'), storeId: firstParty, sellerId: firstParty, name: 'Trail shoe', isActive: true })],
    ])
  })

  it("sends a store's campaigns, and the products it adds to them, to their own topics", async () => {
    const before = bus.published.length
    const res = await retail('campaigns', [
      { eventName: 'campaign_upserted', data: { campaignId: 'C-7', sellerId: 'S-1', placement: 'spotlight', title: 'Spring', status: 'active', productIds: ['SKU-1'] } },
      { eventName: 'campaign_product_added', data: { campaignId: 'C-7', productId: 'SKU-1', sellerId: 'S-1', productName: 'Trail shoe', productPrice: 89.5, category: 'shoes' } },
      { eventName: 'campaign_product_removed', data: { campaignId: 'C-7', productId: 'SKU-2' } },
    ], integration())
    expect(res.status).toBe(202)
    const [campaign, product, sku2] = [externalId(TENANT, 'campaign', 'C-7'), externalId(TENANT, 'product', 'SKU-1'), externalId(TENANT, 'product', 'SKU-2')]
    // Their store is their seller.
    const store = externalId(TENANT, 'seller', 'S-1')
    expect(bus.published.slice(before).map((m) => [m.topic, m.key, m.envelope.eventType, m.envelope.payload])).toEqual([
      [CAMPAIGN_TOPIC, campaign, 'campaign_upserted', expect.objectContaining({ campaignId: campaign, storeId: store, sellerId: store, placement: 'spotlight', tenantId: TENANT, title: 'Spring', productIds: [product] })],
      [CAMPAIGN_PRODUCTS_TOPIC, `${campaign}:${product}`, 'campaign_product_added', {
        campaignId: campaign, productId: product, storeId: store, sellerId: store, productName: 'Trail shoe', productPrice: 89.5, category: 'shoes', tenantId: TENANT, updatedAt: expect.any(String),
      }],
      [CAMPAIGN_PRODUCTS_TOPIC, `${campaign}:${sku2}`, 'campaign_product_removed', { campaignId: campaign, productId: sku2, tenantId: TENANT, updatedAt: expect.any(String) }],
    ])
    // A product needs its name.
    const unnamed = await retail('campaigns', [{ eventName: 'campaign_product_added', data: { campaignId: 'C-7', productId: 'SKU-1' } }], integration())
    expect(unnamed.status).toBe(400)
  })

  it("erases a shopper's staged rows on user_deleted, and records it", async () => {
    const [gone, kept] = [randomUUID(), randomUUID()]
    await insert([{ event_name: 'impression', user_id: gone }, { event_name: 'impression', user_id: kept }])
    await insertSession({ user_id: gone })
    await insertSession({ user_id: kept })
    const now = new Date().toISOString()
    await handleIdentityEvent(clickhouse, {
      eventId: randomUUID(), eventType: 'AnalyticsEventRecorded', eventVersion: 1, occurredAt: now, producer: 'ingestion-service', aggregateId: gone, aggregateVersion: 1,
      payload: { eventName: 'user_deleted', tenantId: TENANT, userId: gone, receivedAt: now },
    })
    const count = async (userId: string, table = 'events') =>
      Number((await (await clickhouse.query({ query: `SELECT count() AS n FROM ${table} WHERE user_id = '${userId}'`, format: 'JSONEachRow' })).json<{ n: string }>())[0]!.n)
    expect(await count(gone)).toBe(0)
    expect(await count(kept)).toBe(1)
    expect(await count(gone, 'sessions')).toBe(0)
    expect(await count(kept, 'sessions')).toBe(1)
    const deleted = await (await clickhouse.query({ query: `SELECT toString(user_id) AS u FROM deleted_users WHERE user_id = '${gone}'`, format: 'JSONEachRow' })).json()
    expect(deleted).toEqual([{ u: gone }])
  })
})
