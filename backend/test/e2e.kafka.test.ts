/**
 * End-to-end through the gateway with a REAL Kafka broker (docker compose up
 * postgres kafka clickhouse). Each service runs in-process with its own database and its
 * own Kafka client; topics use a unique prefix so runs don't interfere.
 *
 *   npm run test:e2e
 */
import { randomUUID } from 'node:crypto'
import type { AddressInfo, Server } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Admin } from '@platformatic/kafka'
import request from 'supertest'
import { decodeJwt } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ANALYTICS_EVENT_NAMES, analyticsTopic, TOPICS, type AnalyticsEventPayload, type EventEnvelope } from '@ecommerce-analytics/contracts'
import {
  closeDb,
  createEventPublisher,
  createKafkaEventBus,
  createLogger,
  ensureTopics,
  idempotentHandler,
  type Database,
  type EventBus,
} from '@ecommerce-analytics/platform'
import { createTestDatabase, createTestKeys } from '@ecommerce-analytics/platform/testing'
import { buildAnalyticsApp } from '../services/analytics-service/src/app.ts'
import { createClickHouse } from '../services/analytics-service/src/clickhouse.ts'
import { handleCampaignEvent } from '../services/analytics-service/src/events/campaign.consumer.ts'
import { buildAuthApp } from '../services/auth-service/src/app.ts'
import { createAuthDb, migrateAuthDb, withTenant } from '../services/auth-service/src/db/client.ts'
import { insertAccount } from '../services/auth-service/src/repositories/account.repository.ts'
import { createUser, PRODUCER as AUTH_PRODUCER } from '../services/auth-service/src/services/user-admin.service.ts'
import { buildCampaignApp } from '../services/campaign-service/src/app.ts'
import { createCampaignDb, migrateCampaignDb } from '../services/campaign-service/src/db/client.ts'
import { handleProductEvent } from '../services/campaign-service/src/events/product.consumer.ts'
import { buildGateway } from '../services/gateway/src/app.ts'
import { createGatewayDb, migrateGatewayDb } from '../services/gateway/src/db/client.ts'
import { handleAccessEvent } from '../services/gateway/src/events/access.consumer.ts'
import { buildProductApp } from '../services/product-service/src/app.ts'
import { createProductDb, migrateProductDb } from '../services/product-service/src/db/client.ts'

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')
const PREFIX = `e2e-${randomUUID().slice(0, 8)}.`
const logger = createLogger('e2e')
const TENANT = randomUUID()

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = []
const dbs: Database<any>[] = []
const buses: EventBus[] = []
const servers: Server[] = []
let gateway: ReturnType<typeof buildGateway>['app']
let authDb: ReturnType<typeof createAuthDb>
let authBus: EventBus
/** What arrived on the analytics.<eventName>.v1 topics (read by the Flink job in production). */
const analyticsMessages: { topic: string; envelope: EventEnvelope<AnalyticsEventPayload> }[] = []
const clickhouse = createClickHouse(process.env.TEST_CLICKHOUSE_URL ?? 'http://ecommerce_analytics:ecommerce_analytics_dev@localhost:8123/analytics')

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

async function listen(app: import('express').Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
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
  const analyticsTopics = ANALYTICS_EVENT_NAMES.map(analyticsTopic)
  await ensureTopics({ brokers: BROKERS, clientId: 'e2e', topicPrefix: PREFIX }, [...Object.values(TOPICS), ...analyticsTopics])
  const keys = await createTestKeys()

  authDb = await database(createAuthDb, migrateAuthDb)
  await insertAccount(authDb, { tenantId: TENANT, name: 'E2E storefront', tier: 'free' })
  authBus = await kafka('auth-service')
  const authUrl = await listen(buildAuthApp({ db: authDb, bus: authBus, logger, privateKey: keys.privateKey, publicKey: keys.publicKey }))

  const productDb = await database(createProductDb, migrateProductDb)
  const productUrl = await listen(buildProductApp({ db: productDb, bus: await kafka('product-service'), logger, publicKey: keys.publicKey }))

  const campaignDb = await database(createCampaignDb, migrateCampaignDb)
  const campaignBus = await kafka('campaign-service')
  await campaignBus.subscribe({ groupId: 'campaign-service', topics: [TOPICS.products], handler: (envelope) => handleProductEvent(campaignDb, envelope) })
  const campaignUrl = await listen(buildCampaignApp({ db: campaignDb, bus: campaignBus, logger, publicKey: keys.publicKey }))

  const analyticsBus = await kafka('analytics-service')
  await analyticsBus.subscribe({ groupId: 'analytics-service', topics: [TOPICS.campaigns], handler: (envelope) => handleCampaignEvent(clickhouse, envelope) })
  const analyticsUrl = await listen(buildAnalyticsApp({ bus: analyticsBus, clickhouse, logger, publicKey: keys.publicKey }))
  const reader = await kafka('e2e-analytics-reader')
  await reader.subscribe({
    groupId: 'e2e-analytics-reader',
    topics: analyticsTopics,
    handler: async (envelope, { topic }) => {
      analyticsMessages.push({ topic, envelope: envelope as EventEnvelope<AnalyticsEventPayload> })
    },
  })

  const gatewayDb = await database(createGatewayDb, migrateGatewayDb)
  const gatewayBus = await kafka('gateway')
  await gatewayBus.subscribe({ groupId: 'gateway', topics: [TOPICS.sessions, TOPICS.users], handler: idempotentHandler(gatewayDb, handleAccessEvent) })
  gateway = buildGateway({
    db: gatewayDb,
    logger,
    publicKey: keys.publicKey,
    services: { auth: authUrl, product: productUrl, campaign: campaignUrl, analytics: analyticsUrl },
    corsOrigins: [],
  }).app
}, 90_000)

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  for (const bus of buses) await bus.close().catch(() => {})
  for (const db of dbs) await closeDb(db)
  for (const db of databases) await db.drop()
  await clickhouse.close()
  const admin = new Admin({ clientId: 'e2e-cleanup', bootstrapBrokers: BROKERS })
  const topics = (await admin.listTopics()).filter((topic) => topic.startsWith(PREFIX))
  if (topics.length > 0) await admin.deleteTopics({ topics })
  await admin.close()
}, 60_000)

describe('the full flow over Kafka', () => {
  it('product → campaign over Kafka, analytics events onto their topics, and logout revocation at the gateway', async () => {
    // The readiness probe's Kafka check works against the real broker.
    await expect(authBus.healthCheck()).resolves.toBeUndefined()

    // An operator creates a campaign manager (what the auth-service CLI does).
    const { events } = await withTenant(authDb, TENANT, (tx) =>
      createUser(tx, { username: 'maya', password: 'correct horse battery', role: 'campaign-manager', tenantId: TENANT }, null),
    )
    await createEventPublisher(authBus, AUTH_PRODUCER, logger)(events)

    const login = await request(gateway).post('/api/v1/auth/login').set('tenant_id', TENANT).send({ username: 'maya', password: 'correct horse battery', clientType: 'web' })
    expect(login.status).toBe(200)
    const auth = `Bearer ${login.body.accessToken}`

    const product = await request(gateway)
      .post('/api/v1/products')
      .set('Authorization', auth)
      .send({ name: 'Aurora Wireless Earbuds', description: 'ANC earbuds', price: 2999, category: 'Audio' })
    expect(product.status).toBe(201)

    // The campaign service learns about the product only through Kafka.
    const { result: campaign, elapsedMs: productLag } = await eventually(
      () =>
        request(gateway)
          .post('/api/v1/campaigns')
          .set('Authorization', auth)
          .send({ title: 'Festive Sale', type: 'seasonal', status: 'active', productIds: [product.body.id] }),
      (res) => res.status !== 409,
    )
    expect(campaign.status).toBe(201)
    logger.info({ productLag }, 'product projection lag')

    // Analytics events go straight onto the topic for their event type.
    const clickId = randomUUID()
    const campaignId = campaign.body.id as string
    const now = Date.now()
    const analyticsEvents = [
      { eventId: randomUUID(), campaignId, eventName: 'impression', timestamp: new Date(now - 3000).toISOString() },
      { eventId: clickId, campaignId, productId: product.body.id, eventName: 'click', timestamp: new Date(now - 2000).toISOString() },
      // Credited to the click by the Flink job (test/flink.kafka.test.ts); the client sends no link.
      { eventId: randomUUID(), productId: product.body.id, eventName: 'add_to_cart', timestamp: new Date(now - 1000).toISOString() },
    ]
    // Metric events count once analytics-service has seen the campaign (CampaignCreated over Kafka).
    const { result: ingest, elapsedMs: campaignLag } = await eventually(
      () => request(gateway)
          .post('/api/v1/analytics/events')
          .set('Authorization', auth)
          // The identity the token was issued for; a mismatch is rejected.
          .send({ tenantId: decodeJwt(login.body.accessToken).tid, userId: decodeJwt(login.body.accessToken).sub, userType: 'registered', events: analyticsEvents }),
      (res) => res.body.accepted === 3,
      20_000,
    )
    expect(ingest.body).toMatchObject({ accepted: 3, rejected: 0 })
    logger.info({ campaignLag }, 'campaign projection lag')

    // Retries above re-publish add_to_cart with the same eventId (stored once in ClickHouse).
    const distinct = () => new Map(analyticsMessages.map((m) => [m.envelope.eventId, m.topic]))
    await eventually(async () => distinct().size, (count) => count >= 3)
    expect([...distinct().values()].sort()).toEqual(['analytics.add_to_cart.v1', 'analytics.click.v1', 'analytics.impression.v1'])
    const click = analyticsMessages.find((m) => m.envelope.eventId === clickId)!
    expect(click.envelope.payload).toMatchObject({ campaignId, productId: product.body.id, userId: login.body.user.id, userType: 'registered', tenantId: TENANT })

    // Logout → SessionRevoked over Kafka → the gateway refuses the token.
    expect((await request(gateway).post('/api/v1/auth/logout').set('Authorization', auth)).status).toBe(200)
    const { result: afterLogout, elapsedMs: revocationLag } = await eventually(
      () => request(gateway).get('/api/v1/products').set('Authorization', auth),
      (res) => res.status === 401,
      10_000,
    )
    expect(afterLogout.body.error.code).toBe('SESSION_REVOKED')
    expect(revocationLag).toBeLessThan(5_000)
  }, 90_000)
})
