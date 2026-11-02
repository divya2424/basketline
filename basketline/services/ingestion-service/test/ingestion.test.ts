import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { decodeJwt } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CATALOG_TOPIC, externalId, IDENTITY_TOPIC, INTERACTIONS_TOPIC } from '@basketline/contracts'
import { createLogger, createMemoryEventBus, signIntegrationToken, signShopperToken, type EventBus, type MemoryEventBus } from '@basketline/platform'
import type { ClickHouse } from '@basketline/platform/clickhouse'
import { createTestClickHouse, createTestKeys, tokenFor, visitorTokenFor, type TestKeys } from '@basketline/platform/testing'
import { buildIngestionApp } from '../src/app.ts'
import { handleIdentityEvent } from '../src/events/identity.consumer.ts'
import { handleReferenceEvent } from '../src/events/reference.consumer.ts'
import { handleTenantEvent } from '../src/events/tenant.consumer.ts'

const HOUR = 3_600_000
const TENANT = '10000000-0000-4000-8000-000000000001'
const OTHER_TENANT = '20000000-0000-4000-8000-000000000002'
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const logger = createLogger('ingestion-test')

let keys: TestKeys
/** A campaign manager of TENANT (not allowed to send reference data). */
let reader: string
/** A visitor of TENANT. */
let visitor: string
let visitorId: string
let db: Awaited<ReturnType<typeof createTestClickHouse>>
let clickhouse: ClickHouse
let bus: MemoryEventBus
let app: ReturnType<typeof buildIngestionApp>

beforeAll(async () => {
  keys = await createTestKeys()
  reader = (await tokenFor(keys, 'campaign-manager', { tid: TENANT })).header
  const visitorToken = await visitorTokenFor(keys, TENANT)
  visitor = visitorToken.header
  visitorId = visitorToken.sub
  db = await createTestClickHouse()
  clickhouse = db.clickhouse
  bus = createMemoryEventBus(logger)
  app = buildIngestionApp({ bus, clickhouse, logger, publicKey: keys.publicKey })
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
function identityOf(auth: string) {
  const { sub, tid, sid } = decodeJwt(auth.replace('Bearer ', ''))
  return { tenantId: tid, userId: sub, userType: sid ? 'registered' : 'visitor' }
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
    .set('Authorization', auth)
    .send({ ...identity, events: events.map(toWire) })

const SELLER = randomUUID()

/** Applies a reference event (retail.catalog-events.v1 / retail.campaign-events.v1), as the Kafka consumer does; version orders them. */
function referenceEvent(eventType: string, aggregateId: string, version: number, payload: object) {
  return handleReferenceEvent(clickhouse, {
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'ingestion-service',
    aggregateId,
    aggregateVersion: version,
    payload: { tenantId: TENANT, updatedAt: new Date().toISOString(), ...payload },
  })
}

/** A campaign_upserted, by default an active campaign of SELLER with no products. */
function campaignEvent(campaignId: string, version: number, state: { status?: string; archived?: boolean; tenantId?: string; sellerId?: string; productIds?: string[] } = {}) {
  return referenceEvent('campaign_upserted', campaignId, version, {
    campaignId, sellerId: SELLER, title: 'Sale', status: 'active', startTime: null, endTime: null, archived: false, productIds: [], ...state,
  })
}

async function activeCampaign() {
  const campaignId = randomUUID()
  await campaignEvent(campaignId, 1)
  return campaignId
}

describe('ingestion: publish to the topic for each event type', () => {
  it("rejects a declared bot's batch as invalid traffic, publishes none of it, and counts it", async () => {
    const counted = async () =>
      Number((await (await clickhouse.query({ query: `SELECT sum(events) AS n FROM invalid_traffic_daily WHERE tenant_id = '${TENANT}' AND reason = 'bot_user_agent'`, format: 'JSONEachRow' })).json<{ n: string }>())[0]?.n ?? 0)
    const before = { published: bus.published.length, counted: await counted() }
    const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
    const res = await send([{ eventName: 'home_view' }, { eventName: 'cart_view' }]).set('User-Agent', googlebot)
    expect(res.body).toMatchObject({ accepted: 0, rejected: 2, results: [{ reason: 'INVALID_TRAFFIC' }, { reason: 'INVALID_TRAFFIC' }] })
    expect(bus.published.length).toBe(before.published)
    // Counted asynchronously (ClickHouse batches the inserts).
    await expect.poll(counted, { timeout: 10_000 }).toBe(before.counted + 2)

    // A browser is not a bot.
    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    expect((await send([{ eventName: 'home_view' }]).set('User-Agent', chrome)).body).toMatchObject({ accepted: 1 })
  })

  it('publishes IDs in lowercase, whatever case the client sent them in', async () => {
    const before = bus.published.length
    const campaignId = await activeCampaign()
    const [eventId, productId] = [randomUUID(), randomUUID()]
    const res = await send([{ eventId: eventId.toUpperCase(), campaignId: campaignId.toUpperCase(), productId: productId.toUpperCase(), eventName: 'click' }])
    expect(res.body).toMatchObject({ accepted: 1 })
    const [message] = bus.published.slice(before)
    expect(message!.key).toBe(eventId)
    expect(message!.envelope).toMatchObject({ eventId, aggregateId: eventId, payload: { eventId, campaignId, productId } })
  })

  it('publishes every accepted event to the interactions topic with the full payload', async () => {
    const before = bus.published.length
    const campaignId = await activeCampaign()
    const productId = randomUUID()
    const clickId = randomUUID()
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
      // The catalog hasn't sent this product: no seller yet.
      sellerId: null,
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
    const { header, sub, tid } = await tokenFor(keys, 'standard-user', { client: 'mobile' })
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
    const user = await tokenFor(keys, 'standard-user', { tid: TENANT })
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

  it("counts a vendor's shopper token as registered, and rejects a batch that claims otherwise", async () => {
    const userId = randomUUID()
    const shopper = `Bearer ${(await signShopperToken(keys.privateKey, { tenantId: TENANT, userId, client: 'mobile' })).token}`
    const before = bus.published.length
    const res = await send([{ eventName: 'home_view' }], shopper, app, { tenantId: TENANT, userId, userType: 'registered' })
    expect(res.status).toBe(200)
    expect(bus.published[before]!.envelope.payload).toMatchObject({ userId, userType: 'registered', clientType: 'mobile', tenantId: TENANT })
    const claimsVisitor = await send([{ eventName: 'home_view' }], shopper, app, { tenantId: TENANT, userId, userType: 'visitor' })
    expect(claimsVisitor.status).toBe(403)
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
    // noTenant: a campaign the retailer never sent is not active either.
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
    const capped = buildIngestionApp({ bus, clickhouse, logger, publicKey: keys.publicKey, maxEventsPerMinute: 3 })
    const token = (await visitorTokenFor(keys, TENANT)).header
    expect((await send([{ eventName: 'home_view' }, { eventName: 'home_view' }], token, capped)).status).toBe(200)
    const over = await send([{ eventName: 'home_view' }, { eventName: 'home_view' }], token, capped)
    expect(over.status).toBe(429)
    expect(over.body.error.code).toBe('TOO_MANY_EVENTS')
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)
    // Other senders have their own allowance.
    expect((await send([{ eventName: 'home_view' }], visitor, capped)).status).toBe(200)
  })

  it("holds a busy tenant to its tier's budget, across its senders, while other tenants' events keep flowing", async () => {
    const budgeted = buildIngestionApp({ bus, clickhouse, logger, publicKey: keys.publicKey, tenantEventsPerMinute: { free: 3, pro: 6, enterprise: 100 } })
    const busy = randomUUID()
    const pro = randomUUID()
    // The tier comes with TenantOnboarded (auth.tenant.v1); a tenant without one counts as free.
    await handleTenantEvent(clickhouse, {
      eventId: randomUUID(),
      eventType: 'TenantOnboarded',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'auth-service',
      aggregateId: pro,
      aggregateVersion: 1,
      payload: { tenantId: pro, name: 'Pro Store', tier: 'pro', onboardedBy: randomUUID(), seed: { productIds: [], sellers: [], campaigns: [] } },
    })
    const two = [{ eventName: 'home_view' }, { eventName: 'home_view' }] as const

    expect((await send([...two], (await visitorTokenFor(keys, busy)).header, budgeted)).status).toBe(200)
    // Another of the same tenant's visitors: the budget is the tenant's, not the sender's.
    const over = await send([...two], (await visitorTokenFor(keys, busy)).header, budgeted)
    expect(over.status).toBe(429)
    expect(over.body.error.code).toBe('TENANT_RATE_LIMITED')
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)

    expect((await send([{ eventName: 'home_view' }], (await visitorTokenFor(keys, OTHER_TENANT)).header, budgeted)).status).toBe(200)
    expect((await send([...two, ...two], (await visitorTokenFor(keys, pro)).header, budgeted)).status).toBe(200)
  })

  it('rejects malformed batches, and events outside the time window without publishing them', async () => {
    const malformed = await request(app)
      .post('/api/v1/analytics/events')
      .set('Authorization', visitor)
      .send({ ...identityOf(visitor), events: [{ eventId: 'x', eventName: 'purchase', timestamp: 'now' }] })
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.details.errors).toEqual(
      expect.arrayContaining(['events[0].eventId must be a UUID', 'events[0].timestamp must be an ISO 8601 date-time']),
    )
    expect((await send([{ eventName: 'click' }])).body.error.details.errors).toEqual(['events[0].properties.campaignId must be a campaign ID (a UUID or your own ID)'])
    // The IDs belong in properties, not at the top level of the event.
    const topLevel = { eventId: randomUUID(), timestamp: ago(60_000), eventName: 'click', campaignId: randomUUID(), productId: randomUUID() }
    expect((await request(app).post('/api/v1/analytics/events').set('Authorization', visitor).send({ ...identityOf(visitor), events: [topLevel] })).body.error.details.errors).toEqual(
      expect.arrayContaining(['events[0]: unknown field "campaignId"', 'events[0]: unknown field "productId"']),
    )
    // Attribution is the platform's: no click_to_basket events, and no attributionId.
    expect((await send([{ campaignId: randomUUID(), eventName: 'click_to_basket', productId: randomUUID() }])).status).toBe(400)
    expect((await send([{ eventName: 'add_to_cart', productId: randomUUID(), attributionId: randomUUID() }])).body.error.details.errors).toEqual([
      'events[0]: unknown field "attributionId"',
    ])
    expect((await request(app).post('/api/v1/analytics/events').set('Authorization', visitor).send({ ...identityOf(visitor), events: [] })).status).toBe(400)

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
    const brokenApp = buildIngestionApp({ bus: broken, clickhouse, logger, publicKey: keys.publicKey })
    const res = await send([{ eventName: 'home_view' }], undefined, brokenApp)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('EVENTS_NOT_DELIVERED')
  })
})

/** Rows as the Flink job writes them (through Kafka). */
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
    await insertSession({ campaigns: [campaignId], minutes: 5 })
    await clickhouse.command({ query: `INSERT INTO sessions (session_id, tenant_id, user_id, user_type, session_start, last_event_time, events, impressions, clicks, add_to_carts, web, mobile, campaigns, clicked, added) VALUES (generateUUIDv4(), '${gone}', generateUUIDv4(), 'visitor', now64(3), now64(3), 1, 1, 0, 0, 1, 0, ['${campaignId}'], [], [])` })

    const count = async (table: string, tenant: string) =>
      Number((await (await clickhouse.query({ query: `SELECT count() AS n FROM ${table} WHERE tenant_id = {t:UUID}`, query_params: { t: tenant }, format: 'JSONEachRow' })).json<{ n: string }>())[0]!.n)
    const tables = ['events', 'attributed_baskets', 'sessions', 'daily_campaign_aggregation', 'daily_campaign_customers_aggregation', 'daily_campaign_sessions_aggregation']
    for (const table of tables) expect(await count(table, gone), table).toBeGreaterThan(0)
    const othersBefore = await Promise.all(tables.map((table) => count(table, TENANT)))

    const envelope = { eventId: randomUUID(), eventType: 'TenantDeleted', eventVersion: 1, occurredAt: new Date().toISOString(), producer: 'auth-service', aggregateId: gone, aggregateVersion: 2, payload: { tenantId: gone, name: 'Gone Store', deletedAt: new Date().toISOString() } }
    await handleTenantEvent(clickhouse, envelope)
    await handleTenantEvent(clickhouse, envelope) // redelivered: harmless

    for (const table of tables) expect(await count(table, gone), table).toBe(0)
    expect(await Promise.all(tables.map((table) => count(table, TENANT)))).toEqual(othersBefore)
    const recorded = await (await clickhouse.query({ query: 'SELECT name, archive_purged_at FROM deleted_tenants FINAL WHERE tenant_id = {t:UUID}', query_params: { t: gone }, format: 'JSONEachRow' })).json()
    expect(recorded).toEqual([{ name: 'Gone Store', archive_purged_at: null }])
  })
})

describe('sellers, retailer IDs and the four event types', () => {
  const integration = async (tenantId = TENANT) => `Bearer ${(await signIntegrationToken(keys.privateKey, tenantId)).token}`
  const retail = (path: string, events: object[], auth: string) => request(app).post(`/api/v1/retail/${path}`).set('Authorization', auth).send({ events })
  const productEvent = (productId: string, sellerId: string) =>
    referenceEvent('product_upserted', productId, 1, { productId, sellerId, name: 'Product', category: null, price: null, isActive: true })

  it("stamps each event with its product's seller from the catalog, and maps a retailer's own IDs", async () => {
    const [sellerId, productId] = [randomUUID(), randomUUID()]
    await productEvent(productId, sellerId)
    // The retailer's own campaign code, registered through its campaign feed.
    const code = `SPRING-${randomUUID().slice(0, 8)}`
    await campaignEvent(externalId(TENANT, 'campaign', code), 1, { sellerId })
    const before = bus.published.length
    const res = await send([{ campaignId: code, productId, eventName: 'click' }, { productId: randomUUID(), eventName: 'product_click' }])
    expect(res.body).toMatchObject({ accepted: 2 })
    const [click, unknown] = bus.published.slice(before).map((m) => m.envelope.payload as Record<string, unknown>)
    expect(click).toMatchObject({ eventType: 'interaction', campaignId: externalId(TENANT, 'campaign', code), productId, sellerId })
    // A product the catalog hasn't sent: accepted, with no seller yet.
    expect(unknown!.sellerId).toBeNull()
  })

  it('sends login activity to the identity topic, and refuses server-only identity events from a client', async () => {
    const before = bus.published.length
    expect((await send([{ eventName: 'login_click' }])).body).toMatchObject({ accepted: 1 })
    const [message] = bus.published.slice(before)
    expect(message!.topic).toBe(IDENTITY_TOPIC)
    expect(message!.envelope.payload).toMatchObject({ eventType: 'identity', eventName: 'login_click' })
    expect((await send([{ eventName: 'user_deleted' as never }])).status).toBe(400)
  })

  it("takes reference data only with an integration token, mapping the retailer's IDs and its first-party seller", async () => {
    const product = [{ eventName: 'product_upserted', data: { productId: 'SKU-1', name: 'Trail shoe' } }]
    expect((await retail('catalog', product, visitor)).status).toBe(401)
    expect((await retail('catalog', product, reader)).status).toBe(401)
    expect((await retail('campaigns', [{ eventName: 'campaign_upserted', data: { campaignId: 'C-1', title: 'x', status: 'active', productIds: [] } }], await integration())).status).toBe(400)

    const before = bus.published.length
    expect((await retail('catalog', product, await integration())).status).toBe(202)
    const firstParty = externalId(TENANT, 'seller', 'first-party')
    const published = bus.published.slice(before)
    expect(published.every((m) => m.topic === CATALOG_TOPIC)).toBe(true)
    expect(published.map((m) => [m.envelope.eventType, m.envelope.payload])).toEqual([
      ['seller_upserted', expect.objectContaining({ sellerId: firstParty, tenantId: TENANT })],
      ['product_upserted', expect.objectContaining({ productId: externalId(TENANT, 'product', 'SKU-1'), sellerId: firstParty, name: 'Trail shoe', isActive: true })],
    ])
  })

  it("flags a campaign that includes another seller's product, and keeps it", async () => {
    const [ours, theirs, campaignId] = [randomUUID(), randomUUID(), randomUUID()]
    const sellerId = randomUUID()
    await productEvent(ours, sellerId)
    await productEvent(theirs, randomUUID())
    await campaignEvent(campaignId, 1, { sellerId, productIds: [ours, theirs] })
    const result = await clickhouse.query({ query: `SELECT issues FROM campaigns FINAL WHERE campaign_id = '${campaignId}'`, format: 'JSONEachRow' })
    expect(await result.json()).toEqual([{ issues: [`product ${theirs} belongs to another seller`] }])
  })

  it("erases a shopper's rows on user_deleted, and records it for the archive", async () => {
    const [gone, kept] = [randomUUID(), randomUUID()]
    await insert([{ event_name: 'home_view', user_id: gone }, { event_name: 'home_view', user_id: kept }])
    const now = new Date().toISOString()
    await handleIdentityEvent(clickhouse, {
      eventId: randomUUID(), eventType: 'AnalyticsEventRecorded', eventVersion: 1, occurredAt: now, producer: 'ingestion-service', aggregateId: gone, aggregateVersion: 1,
      payload: { eventName: 'user_deleted', tenantId: TENANT, userId: gone, receivedAt: now },
    })
    const count = async (userId: string) => Number((await (await clickhouse.query({ query: `SELECT count() AS n FROM events WHERE user_id = '${userId}'`, format: 'JSONEachRow' })).json<{ n: string }>())[0]!.n)
    expect(await count(gone)).toBe(0)
    expect(await count(kept)).toBe(1)
    const deleted = await (await clickhouse.query({ query: `SELECT toString(user_id) AS u FROM deleted_users WHERE user_id = '${gone}'`, format: 'JSONEachRow' })).json()
    expect(deleted).toEqual([{ u: gone }])
  })
})
