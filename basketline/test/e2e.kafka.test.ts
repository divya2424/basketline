/**
 * End-to-end through the gateway with a REAL Kafka broker (docker compose up
 * postgres kafka clickhouse). Each service runs in-process with its own database and its
 * own Kafka client; topics use a unique prefix so runs don't interfere. The
 * simulated retailer's services run too, and reach Basketline only through the
 * gateway with the API key its onboarding returned, as a real retailer's would.
 *
 *   pnpm test:e2e
 */
import { randomUUID } from 'node:crypto'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Admin } from '@platformatic/kafka'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CAMPAIGN_PRODUCTS_TOPIC, CAMPAIGN_TOPIC, CATALOG_TOPIC, IDENTITY_TOPIC, INTERACTIONS_TOPIC, TOPICS, type AnalyticsEventPayload, type EventEnvelope } from '@basketline/contracts'
import { closeDb, createEventPublisher, createKafkaEventBus, createLogger, ensureTopics, idempotentHandler, type Database, type EventBus } from '@basketline/platform'
import { createTestDatabase, createTestKeys } from '@basketline/platform/testing'
import { createClickHouse } from '@basketline/platform/clickhouse'
import { buildIngestionApp } from '../services/ingestion-service/src/app.ts'
import { buildInsightsApp } from '../services/insights-service/src/app.ts'
import { buildAuthApp } from '../services/auth-service/src/app.ts'
import { createAuthDb, migrateAuthDb } from '../services/auth-service/src/db/client.ts'
import { insertAccount } from '../services/auth-service/src/repositories/account.repository.ts'
import { createShopperService } from '../services/auth-service/src/services/shopper.service.ts'
import { buildGateway } from '../services/gateway/src/app.ts'
import { createGatewayDb, migrateGatewayDb } from '../services/gateway/src/db/client.ts'
import { handleAccessEvent } from '../services/gateway/src/events/access.consumer.ts'
// The simulated retailer (../../retailer-sim), wired as its services' index.ts files do.
import { createBasketlineClient, createBasketlineSender, openSecret, RETAILER_EVENTS, RETAILER_TOPICS } from '../../retailer-sim/packages/shared/src/index.ts'
import { buildRetailerAuthApp } from '../../retailer-sim/services/retailer-auth-service/src/app.ts'
import { createRetailerAuthDb, migrateRetailerAuthDb } from '../../retailer-sim/services/retailer-auth-service/src/db/client.ts'
import { buildProductApp } from '../../retailer-sim/services/product-service/src/app.ts'
import { createProductDb, migrateProductDb } from '../../retailer-sim/services/product-service/src/db/client.ts'
import { createStoreConnector as connectProductStore } from '../../retailer-sim/services/product-service/src/events/store.consumer.ts'
import { findSealedApiKey as productStoreKey } from '../../retailer-sim/services/product-service/src/repositories/store.repository.ts'
import { buildCampaignApp } from '../../retailer-sim/services/campaign-service/src/app.ts'
import { createCampaignDb, migrateCampaignDb } from '../../retailer-sim/services/campaign-service/src/db/client.ts'
import { handleProductEvent } from '../../retailer-sim/services/campaign-service/src/events/product.consumer.ts'
import { createStoreConnector as connectCampaignStore } from '../../retailer-sim/services/campaign-service/src/events/store.consumer.ts'
import { findSealedApiKey as campaignStoreKey } from '../../retailer-sim/services/campaign-service/src/repositories/store.repository.ts'

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')
const PREFIX = `e2e-${randomUUID().slice(0, 8)}.`
const logger = createLogger('e2e')
/** A vendor onboarded with the auth CLI, for the SDK-endpoints test. */
const TENANT = randomUUID()
const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = []
const dbs: Database<any>[] = []
const buses: EventBus[] = []
const servers: Server[] = []
let gateway: ReturnType<typeof buildGateway>['app']
let authDb: ReturnType<typeof createAuthDb>
let authBus: EventBus
let retailerAuthUrl: string
let productUrl: string
let campaignUrl: string
/** What arrived on retail.interactions.v1 (read by the Flink job in production). */
const analyticsMessages: { topic: string; envelope: EventEnvelope<AnalyticsEventPayload> }[] = []
/** What the retail API wrote to the campaign topics (read by the data lake and ClickHouse in production). */
const retailMessages: { topic: string; envelope: EventEnvelope<Record<string, unknown>> }[] = []
const clickhouse = createClickHouse(process.env.TEST_CLICKHOUSE_URL ?? 'http://basketline:basketline_dev@localhost:8123/analytics')
// The insights API reads as the tenant-scoped reader user (infra/clickhouse/04_access.sql).
const readerClickhouse = createClickHouse(process.env.TEST_CLICKHOUSE_READER_URL ?? 'http://basketline_reader:basketline_reader_dev@localhost:8123/analytics')

/** A fresh database for one service, migrated with that service's Drizzle migrations. */
async function database<D extends Database<any>>(create: (url: string) => D, migrate: (db: D) => Promise<void>): Promise<D> {
  const testDb = await createTestDatabase()
  databases.push(testDb)
  const db = create(testDb.url)
  dbs.push(db)
  await migrate(db)
  return db
}

async function kafka(clientId: string): Promise<EventBus> {
  const bus = await createKafkaEventBus({ brokers: BROKERS, clientId, topicPrefix: PREFIX, logger })
  buses.push(bus)
  return bus
}

async function listen(app: RequestListener): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = createServer(app).listen(0, () => resolve(s))
  })
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** Retries `attempt` until `done(result)` or the timeout; returns the last result and elapsed ms. */
async function eventually<T>(attempt: () => Promise<T>, done: (result: T) => boolean, timeoutMs = 20_000) {
  const started = Date.now()
  let result = await attempt()
  while (!done(result) && Date.now() - started < timeoutMs) {
    await sleep(200)
    result = await attempt()
  }
  return { result, elapsedMs: Date.now() - started }
}

beforeAll(async () => {
  await ensureTopics({ brokers: BROKERS, clientId: 'e2e', topicPrefix: PREFIX }, [
    ...Object.values(TOPICS),
    INTERACTIONS_TOPIC,
    IDENTITY_TOPIC,
    CATALOG_TOPIC,
    CAMPAIGN_TOPIC,
    CAMPAIGN_PRODUCTS_TOPIC,
    ...Object.values(RETAILER_TOPICS),
  ])
  const keys = await createTestKeys()
  // The retailer signs its own tokens with its own keys.
  const retailerKeys = await createTestKeys()

  authDb = await database(createAuthDb, migrateAuthDb)
  await insertAccount(authDb, { tenantId: TENANT, name: 'E2E vendor', tier: 'free' })
  authBus = await kafka('auth-service')
  const authUrl = await listen(buildAuthApp({ db: authDb, bus: authBus, logger, privateKey: keys.privateKey, publicKey: keys.publicKey }))
  // Basketline's public API for the retailer: the gateway, built last.
  const basketlineApi = `${await listen((req, res) => gateway(req, res))}/api/v1`

  const retailerAuthDb = await database(createRetailerAuthDb, migrateRetailerAuthDb)
  retailerAuthUrl = await listen(
    buildRetailerAuthApp({
      db: retailerAuthDb,
      bus: await kafka('retailer-auth-service'),
      logger,
      privateKey: retailerKeys.privateKey,
      publicKey: retailerKeys.publicKey,
      basketline: createBasketlineClient({ apiUrl: basketlineApi }),
      secretsKey: SECRETS_KEY,
    }),
  )

  const productDb = await database(createProductDb, migrateProductDb)
  const productBus = await kafka('product-service')
  const productSender = createBasketlineSender({
    apiUrl: basketlineApi,
    apiKeyFor: async (tenantId) => {
      const sealed = await productStoreKey(productDb, tenantId)
      return sealed ? openSecret(sealed, SECRETS_KEY) : null
    },
    logger,
  })
  const productPublish = createEventPublisher(productBus, 'product-service', logger, { registry: RETAILER_EVENTS })
  await productBus.subscribe({ groupId: 'product-service', topics: [RETAILER_TOPICS.stores], handler: connectProductStore({ db: productDb, publish: productPublish, basketline: productSender }) })
  productUrl = await listen(buildProductApp({ db: productDb, bus: productBus, logger, publicKey: retailerKeys.publicKey, basketline: productSender }))

  const campaignDb = await database(createCampaignDb, migrateCampaignDb)
  const campaignBus = await kafka('campaign-service')
  const campaignSender = createBasketlineSender({
    apiUrl: basketlineApi,
    apiKeyFor: async (tenantId) => {
      const sealed = await campaignStoreKey(campaignDb, tenantId)
      return sealed ? openSecret(sealed, SECRETS_KEY) : null
    },
    logger,
  })
  const connectCampaigns = connectCampaignStore({ db: campaignDb, publish: createEventPublisher(campaignBus, 'campaign-service', logger, { registry: RETAILER_EVENTS }), basketline: campaignSender })
  await campaignBus.subscribe({
    groupId: 'campaign-service',
    topics: [RETAILER_TOPICS.products, RETAILER_TOPICS.stores],
    handler: async (envelope) => {
      await handleProductEvent(campaignDb, envelope, campaignSender)
      await connectCampaigns(envelope)
    },
  })
  campaignUrl = await listen(buildCampaignApp({ db: campaignDb, bus: campaignBus, logger, publicKey: retailerKeys.publicKey, basketline: campaignSender }))

  const ingestionBus = await kafka('ingestion-service')
  const ingestionUrl = await listen(buildIngestionApp({ bus: ingestionBus, clickhouse, logger, publicKey: keys.publicKey }))
  const insightsUrl = await listen(buildInsightsApp({ clickhouse: readerClickhouse, logger, publicKey: keys.publicKey }))
  const reader = await kafka('e2e-analytics-reader')
  await reader.subscribe({
    groupId: 'e2e-analytics-reader',
    topics: [INTERACTIONS_TOPIC, CAMPAIGN_TOPIC, CAMPAIGN_PRODUCTS_TOPIC],
    handler: async (envelope, { topic }) => {
      if (topic.endsWith(INTERACTIONS_TOPIC)) analyticsMessages.push({ topic, envelope: envelope as EventEnvelope<AnalyticsEventPayload> })
      else retailMessages.push({ topic, envelope: envelope as EventEnvelope<Record<string, unknown>> })
    },
  })

  const gatewayDb = await database(createGatewayDb, migrateGatewayDb)
  const gatewayBus = await kafka('gateway')
  await gatewayBus.subscribe({ groupId: 'gateway', topics: [TOPICS.sessions, TOPICS.users], handler: idempotentHandler(gatewayDb, handleAccessEvent) })
  gateway = buildGateway({
    db: gatewayDb,
    logger,
    publicKey: keys.publicKey,
    services: { auth: authUrl, ingestion: ingestionUrl, insights: insightsUrl },
    corsOrigins: [],
  }).app
}, 90_000)

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  for (const bus of buses) await bus.close().catch(() => {})
  for (const db of dbs) await closeDb(db)
  for (const db of databases) await db.drop()
  await clickhouse.close()
  await readerClickhouse.close()
  const admin = new Admin({ clientId: 'e2e-cleanup', bootstrapBrokers: BROKERS })
  const topics = (await admin.listTopics()).filter((topic) => topic.startsWith(PREFIX))
  if (topics.length > 0) await admin.deleteTopics({ topics })
  await admin.close()
}, 60_000)

describe('the simulated retailer, through Basketline\'s public API', () => {
  it("onboards a marketplace; a seller's campaign in a placement and its products reach Basketline, its customer's events count under the seller, and the seller reads the results", async () => {
    // The readiness probe's Kafka check works against the real broker.
    await expect(authBus.healthCheck()).resolves.toBeUndefined()

    // The retailer connects a store: its backend onboards it at Basketline (POST /accounts) and keeps the API key.
    const connected = await request(retailerAuthUrl).post('/api/v1/stores').send({ name: 'E2E store', tier: 'free' })
    expect(connected.status).toBe(201)
    const tenantId = connected.body.store.tenantId as string
    expect(connected.body.basketlineUsers.map((user: { username: string }) => user.username)).toEqual(['onboarding'])

    // A seller signs in to the marketplace's seller portal; the staff list a product for it.
    const login = (username: string) => request(retailerAuthUrl).post('/api/v1/auth/login').set('tenant_id', tenantId).send({ username, password: 'test' })
    const seller = await login('seller1')
    expect(seller.status).toBe(200)
    const sellerId = seller.body.user.sellerId as string
    const asSeller = `Bearer ${seller.body.accessToken}`
    const staff = await login('staff')
    // The store's sellers come with its seed (StoreConnected, over Kafka).
    const { result: product } = await eventually(
      () =>
        request(productUrl)
          .post('/api/v1/products')
          .set('Authorization', `Bearer ${staff.body.accessToken}`)
          .send({ sellerId, name: 'Aurora Wireless Earbuds', description: 'ANC earbuds', price: 2999, category: 'Audio' }),
      (res) => res.status === 201,
    )
    expect(product.status).toBe(201)
    const productId = product.body.id as string
    // The seller puts it in a Spotlight campaign. The campaign service learns the
    // product and the store's placements only through Kafka.
    const { result: campaign, elapsedMs: productLag } = await eventually(
      () =>
        request(campaignUrl)
          .post('/api/v1/campaigns')
          .set('Authorization', asSeller)
          .send({ title: 'Festive Sale', placement: 'spotlight', status: 'active', productIds: [productId] }),
      (res) => res.status === 201,
    )
    expect(campaign.body).toMatchObject({ sellerId, placement: 'spotlight' })
    logger.info({ productLag }, 'product projection lag')
    const campaignId = campaign.body.id as string

    // Basketline's retail API: the campaign with its placement, and the product added to it, with the seller as their store.
    const retail = (eventType: string) => retailMessages.find((m) => m.envelope.eventType === eventType && m.envelope.payload.campaignId === campaignId)?.envelope.payload
    await eventually(async () => [retail('campaign_upserted'), retail('campaign_product_added')], (found) => found.every(Boolean))
    expect(retail('campaign_upserted')).toMatchObject({ storeId: sellerId, sellerId, placement: 'spotlight', title: 'Festive Sale', productIds: [productId] })
    expect(retail('campaign_product_added')).toMatchObject({ productId, storeId: sellerId, sellerId, productName: 'Aurora Wireless Earbuds', productPrice: 2999, category: 'Audio' })

    // Basketline's dashboard: the tenant's campaign manager signs in.
    const manager = await request(gateway).post('/api/v1/auth/login').set('tenant_id', tenantId).send({ username: 'onboarding', password: connected.body.basketlinePassword, clientType: 'web' })
    expect(manager.status).toBe(200)
    const asManager = `Bearer ${manager.body.accessToken}`

    // A customer signs in at the store: its backend gets them a Basketline shopper token with the API key.
    const visitorId = randomUUID()
    const customer = await request(retailerAuthUrl).post('/api/v1/auth/login').set('tenant_id', tenantId).send({ username: 'user01', password: 'test', visitorId })
    expect(customer.status).toBe(200)
    const { userId, shopperToken } = customer.body.basketline as { userId: string; shopperToken: string }
    expect(userId).toBe(visitorId)

    // The browser (SDK) sends their events with it: Basketline's ID for them,
    // registered; each ad event with its seller as the store.
    const clickId = randomUUID()
    const now = Date.now()
    const analyticsEvents = [
      { eventId: randomUUID(), eventName: 'impression', storeId: sellerId, timestamp: new Date(now - 3000).toISOString(), properties: { campaignId, productId } },
      { eventId: clickId, eventName: 'click', storeId: sellerId, timestamp: new Date(now - 2000).toISOString(), properties: { campaignId, productId } },
      // Credited to the click by the Flink job (test/flink.kafka.test.ts); the client sends no link.
      { eventId: randomUUID(), eventName: 'add_to_cart', storeId: sellerId, timestamp: new Date(now - 1000).toISOString(), properties: { productId } },
    ]
    const ingest = await request(gateway).post('/api/v1/analytics/events').set('Authorization', `Bearer ${shopperToken}`).send({ tenantId, userId, userType: 'registered', events: analyticsEvents })
    expect(ingest.body).toMatchObject({ accepted: 3, rejected: 0 })

    await eventually(async () => analyticsMessages.find((m) => m.envelope.eventId === clickId), Boolean)
    const click = analyticsMessages.find((m) => m.envelope.eventId === clickId)!
    expect(click.topic).toBe(INTERACTIONS_TOPIC)
    expect(click.envelope.payload).toMatchObject({ campaignId, productId, storeId: sellerId, eventType: 'interaction', userId, userType: 'registered', tenantId })

    // The seller portal: the campaign's results per product, which the campaign
    // service reads from Basketline (GET /ad/{id}/products) with the store's API key.
    // Flink doesn't run here, so the product has no counts yet.
    const results = await request(campaignUrl).get(`/api/v1/campaigns/${campaignId}/results`).set('Authorization', asSeller)
    expect(results.status).toBe(200)
    expect(results.body.items).toEqual([expect.objectContaining({ productId, name: 'Aurora Wireless Earbuds', impressions: 0, clicks: 0, addToCarts: 0 })])

    // Logout → SessionRevoked over Kafka → the gateway refuses the manager's token.
    expect((await request(gateway).post('/api/v1/auth/logout').set('Authorization', asManager)).status).toBe(200)
    const { result: afterLogout, elapsedMs: revocationLag } = await eventually(
      () => request(gateway).get('/api/v1/ad/campaigns').set('Authorization', asManager),
      (res) => res.status === 401,
      10_000,
    )
    expect(afterLogout.body.error.code).toBe('SESSION_REVOKED')
    expect(revocationLag).toBeLessThan(5_000)
  }, 120_000)
})

describe("a vendor's site, through the SDK's endpoints", () => {
  it('sends a visitor\'s events, then the signed-in shopper\'s (vouched for with an API key) as the same person', async () => {
    const vendorSite = 'https://shop.vendor.example'
    // The SDK's endpoints accept any origin.
    const preflight = await request(gateway).options('/api/v1/analytics/events').set('Origin', vendorSite).set('Access-Control-Request-Method', 'POST')
    expect(preflight.headers['access-control-allow-origin']).toBe(vendorSite)

    // The browser (SDK): a visitor token for its visitor ID, then events.
    const visitorId = randomUUID()
    const visitor = await request(gateway).post('/api/v1/auth/visitor').set('tenant_id', TENANT).send({ userId: visitorId, clientType: 'web' })
    expect(visitor.status).toBe(201)
    const asVisitor = { eventId: randomUUID(), eventName: 'home_view', timestamp: new Date().toISOString() }
    const sentAsVisitor = await request(gateway)
      .post('/api/v1/analytics/events')
      .set('Authorization', `Bearer ${visitor.body.visitorToken}`)
      .send({ tenantId: TENANT, userId: visitorId, userType: 'visitor', events: [asVisitor] })
    expect(sentAsVisitor.body).toMatchObject({ accepted: 1 })

    // The vendor's backend: its API key and its own customer ID → a shopper token.
    const { key } = await createShopperService({ db: authDb, privateKey: undefined as never }).createApiKey(TENANT, 'e2e vendor')
    const shopper = await request(gateway)
      .post('/api/v1/auth/shopper-token')
      .set('tenant_id', TENANT)
      .set('Authorization', `ApiKey ${key}`)
      .send({ customerId: 'vendor-customer-1', visitorId })
    expect(shopper.status).toBe(201)
    expect(shopper.body.userId).toBe(visitorId)
    const wrongKey = await request(gateway).post('/api/v1/auth/shopper-token').set('tenant_id', TENANT).set('Authorization', 'ApiKey bl_sk_wrong').send({ customerId: 'x' })
    expect(wrongKey.status).toBe(401)

    // The browser again, identified: registered, the same person.
    const asShopper = { eventId: randomUUID(), eventName: 'cart_view', timestamp: new Date().toISOString() }
    const sentAsShopper = await request(gateway)
      .post('/api/v1/analytics/events')
      .set('Authorization', `Bearer ${shopper.body.shopperToken}`)
      .send({ tenantId: TENANT, userId: visitorId, userType: 'registered', events: [asShopper] })
    expect(sentAsShopper.body).toMatchObject({ accepted: 1 })
    // A shopper token opens nothing but event ingestion.
    expect((await request(gateway).get('/api/v1/auth/me').set('Authorization', `Bearer ${shopper.body.shopperToken}`)).status).toBe(401)

    const payloadOf = (eventId: string) => analyticsMessages.find((m) => m.envelope.eventId === eventId)?.envelope.payload
    await eventually(async () => [payloadOf(asVisitor.eventId), payloadOf(asShopper.eventId)], (found) => found.every(Boolean))
    expect(payloadOf(asVisitor.eventId)).toMatchObject({ userId: visitorId, userType: 'visitor', tenantId: TENANT })
    expect(payloadOf(asShopper.eventId)).toMatchObject({ userId: visitorId, userType: 'registered', tenantId: TENANT })
  }, 60_000)
})
