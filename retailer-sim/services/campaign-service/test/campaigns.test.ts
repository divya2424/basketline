import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '@basketline/contracts'
import { closeDb, createEventPublisher, createLogger, createMemoryEventBus, type MemoryEventBus } from '@basketline/platform'
import { createTestDatabase, createTestKeys } from '@basketline/platform/testing'
import { openSecret, RETAILER_EVENTS, RETAILER_TOPICS, sealSecret } from '@retailer-sim/shared'
import { createFakeBasketline, retailerTokenFor } from '@retailer-sim/shared/testing'
import { buildCampaignApp } from '../src/app.ts'
import { createCampaignDb, migrateCampaignDb, type Db } from '../src/db/client.ts'
import { handleProductEvent } from '../src/events/product.consumer.ts'
import { fillCampaignSellers } from '../src/repositories/campaign.repository.ts'
import { createStoreConnector } from '../src/events/store.consumer.ts'
import { insertPlacementsIfAbsent } from '../src/repositories/placement.repository.ts'
import { findSealedApiKey } from '../src/repositories/store.repository.ts'
import { DEFAULT_PLACEMENTS } from '../src/services/placement.service.ts'

let testDb: Awaited<ReturnType<typeof createTestDatabase>>
let db: Db
let bus: MemoryEventBus
let app: ReturnType<typeof buildCampaignApp>
const TENANT = '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01'
// The tenant's seller running the test campaigns, and another of its sellers.
const SELLER = randomUUID()
const OTHER_SELLER = randomUUID()

/** What the service sent to Basketline with the SDK, as the store's backend. */
const { basketline, sent, results, metrics } = createFakeBasketline()
const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')
/** The store's staff (they write campaigns), customers, and another store's. */
let manager: string
let managerId: string
// Another staff member of the same store.
let colleague: string
let colleagueId: string
let user: string
let otherManager: string
let otherUser: string
let otherTenant: string
/** Sellers of TENANT: SELLER's and OTHER_SELLER's logins. */
let seller: string
let otherSeller: string
let applyProductEvent: (envelope: EventEnvelope) => Promise<void>

beforeAll(async () => {
  testDb = await createTestDatabase()
  db = createCampaignDb(testDb.url)
  await migrateCampaignDb(db)
  const keys = await createTestKeys()
  const logger = createLogger('campaign-test')
  bus = createMemoryEventBus(logger)
  app = buildCampaignApp({ db, bus, logger, publicKey: keys.publicKey, basketline })
  const managerToken = await retailerTokenFor(keys.privateKey, 'staff', { tid: TENANT })
  manager = managerToken.header
  managerId = managerToken.sub
  const colleagueToken = await retailerTokenFor(keys.privateKey, 'staff', { tid: TENANT })
  colleague = colleagueToken.header
  colleagueId = colleagueToken.sub
  user = (await retailerTokenFor(keys.privateKey, 'customer', { tid: TENANT })).header
  otherTenant = randomUUID()
  otherManager = (await retailerTokenFor(keys.privateKey, 'staff', { tid: otherTenant })).header
  otherUser = (await retailerTokenFor(keys.privateKey, 'customer', { tid: otherTenant })).header
  applyProductEvent = (envelope) => handleProductEvent(db, envelope, basketline)
  const sellerToken = await retailerTokenFor(keys.privateKey, 'seller', { tid: TENANT, sel: SELLER })
  seller = sellerToken.header
  otherSeller = (await retailerTokenFor(keys.privateKey, 'seller', { tid: TENANT, sel: OTHER_SELLER })).header
  // The marketplaces' placements (a connected store gets them with StoreConnected).
  for (const tenantId of [TENANT, otherTenant]) await insertPlacementsIfAbsent(db, tenantId, DEFAULT_PLACEMENTS)
})

afterAll(async () => {
  await closeDb(db)
  await testDb.drop()
})

function productEvent(eventType: string, productId: string, version: number, payload: object, eventId = randomUUID(), tenantId = TENANT): EventEnvelope {
  return {
    eventId,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'product-service',
    aggregateId: productId,
    aggregateVersion: version,
    payload: { productId, tenantId, ...payload },
  }
}

// The product manager in product events.
const PRODUCT_ACTOR = randomUUID()
const productState = (name: string, isActive = true, sellerId = SELLER) => ({
  sellerId,
  name,
  price: 999,
  image: null,
  category: 'Audio',
  isActive,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdBy: PRODUCT_ACTOR,
  updatedBy: PRODUCT_ACTOR,
})

/** Simulates the product service announcing a product of `tenantId` over Kafka. */
async function knownProduct(name = 'Product', isActive = true, tenantId = TENANT, sellerId = SELLER) {
  const id = randomUUID()
  await applyProductEvent(productEvent('ProductCreated', id, 1, productState(name, isActive, sellerId), randomUUID(), tenantId))
  return id
}

// The test seller unless the body names one (or none: sellerId undefined).
const create = (body: object, auth = manager) => request(app).post('/api/v1/campaigns').set('Authorization', auth).send({ sellerId: SELLER, ...body })
const campaignCount = async () => (await db.$client.query('SELECT count(*)::int AS n FROM campaigns')).rows[0].n as number

describe('creating campaigns', () => {
  it("is one seller's, with only that seller's products, and goes to Basketline with them", async () => {
    const [ours, theirs] = [await knownProduct('Ours'), await knownProduct('Theirs', true, TENANT, OTHER_SELLER)]
    expect((await create({ title: 'No seller', placement: 'spotlight', sellerId: undefined })).status).toBe(400)
    const mixed = await create({ title: 'Mixed', placement: 'spotlight', productIds: [ours, theirs] })
    expect(mixed.status).toBe(422)
    expect(mixed.body.error).toMatchObject({ code: 'PRODUCT_OF_ANOTHER_SELLER', details: { productIds: [theirs] } })
    // Nor added later.
    const { body } = await create({ title: 'Ours only', placement: 'spotlight', productIds: [ours] })
    expect(body.sellerId).toBe(SELLER)
    expect((await request(app).post(`/api/v1/campaigns/${body.id}/products`).set('Authorization', manager).send({ productIds: [theirs] })).status).toBe(422)

    const call = sent.findLast((s) => s.call === 'campaigns.upsert' && s.records.some((r) => r.campaignId === body.id))!
    expect(call).toMatchObject({ tenantId: TENANT, call: 'campaigns.upsert' })
    expect(call.records[0]).toMatchObject({ campaignId: body.id, sellerId: SELLER, title: 'Ours only', productIds: [ours], archived: false })
  })

  it('saves the campaign with its products in order and publishes the events', async () => {
    const [a, b] = [await knownProduct('A'), await knownProduct('B')]
    const res = await create({
      title: 'Festive Electronics Sale',
      placement: 'spotlight',
      description: 'Special seasonal offers',
      startTime: '2026-11-01T00:00:00Z',
      endTime: '2026-11-15T23:59:59Z',
      productIds: [a, b],
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ title: 'Festive Electronics Sale', status: 'draft', archived: false, productIds: [a, b] })
    expect(res.body.startTime).toBe('2026-11-01T00:00:00.000Z')

    const events = bus.published.filter((m) => m.key === res.body.id).map((m) => m.envelope)
    expect(events.map((e) => e.eventType)).toEqual(['CampaignCreated', 'CampaignProductAssociated', 'CampaignProductAssociated'])
    expect(events[0]!.payload).toMatchObject({ campaignId: res.body.id, tenantId: TENANT })
    expect(events[1]).toMatchObject({ aggregateVersion: 1, payload: { productId: a, position: 1 } })
    expect(bus.published.every((m) => m.topic === RETAILER_TOPICS.campaigns)).toBe(true)
  })

  it('returns a retryable 409 for products the projection has not seen yet', async () => {
    const before = await campaignCount()
    const unknown = randomUUID()
    const res = await create({ title: 'Too early', placement: 'spotlight', productIds: [unknown] })
    expect(res.status).toBe(409)
    expect(res.headers['retry-after']).toBe('5')
    expect(res.body.error).toMatchObject({ code: 'PRODUCT_NOT_YET_AVAILABLE', details: { retryable: true, productIds: [unknown] } })
    expect(await campaignCount()).toBe(before)
  })

  it('rejects inactive products and rolls back the whole campaign', async () => {
    const before = await campaignCount()
    const publishedBefore = bus.published.length
    const res = await create({ title: 'Has inactive', placement: 'spotlight', productIds: [await knownProduct('ok'), await knownProduct('off', false)] })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('PRODUCT_INACTIVE')
    expect(await campaignCount()).toBe(before)
    expect(bus.published.length).toBe(publishedBefore)
  })

  it('rejects duplicate product IDs in the request', async () => {
    const id = await knownProduct()
    const res = await create({ title: 'Dupes', placement: 'spotlight', productIds: [id, id] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DUPLICATE_PRODUCT_IDS')
  })

  it('validates fields and schedules', async () => {
    const bad = await create({ title: '', placement: 'spotlight', status: 'completed', startTime: 'tomorrow', extra: 1 })
    expect(bad.status).toBe(400)
    expect(bad.body.error.details.errors).toEqual(
      expect.arrayContaining(['unknown field "extra"', 'title is required (max 255 characters)', 'status must be "draft" or "active" when creating']),
    )
    const backwards = await create({ title: 'T', placement: 'spotlight', startTime: '2026-11-15T00:00:00Z', endTime: '2026-11-01T00:00:00Z' })
    expect(backwards.body.error.code).toBe('INVALID_SCHEDULE')
  })

  it('forbids customers from creating or changing campaigns; anyone can read', async () => {
    expect((await create({ title: 'Nope', placement: 'spotlight' }, user)).status).toBe(403)
    const { body } = await create({ title: 'Readable', placement: 'spotlight' })
    expect((await request(app).patch(`/api/v1/campaigns/${body.id}`).set('Authorization', user).send({ title: 'x' })).status).toBe(403)
    expect((await request(app).get(`/api/v1/campaigns/${body.id}`).set('Authorization', user)).status).toBe(200)
    expect((await request(app).get('/api/v1/campaigns').set('tenant_id', TENANT)).status).toBe(200)
    expect((await request(app).get('/api/v1/campaigns')).body.error.code).toBe('TENANT_REQUIRED')
    expect((await request(app).post('/api/v1/campaigns').send({ title: 'x', placement: 'spotlight' })).status).toBe(401)
  })
})

describe('tenants', () => {
  it("shows, changes and lists only the caller's tenant's campaigns", async () => {
    const { body } = await create({ title: 'Ours', placement: 'spotlight', productIds: [await knownProduct()] })
    const path = `/api/v1/campaigns/${body.id}`
    const ids = (res: request.Response) => res.body.items.map((c: { id: string }) => c.id)

    expect(ids(await request(app).get('/api/v1/campaigns?limit=100').set('Authorization', user))).toContain(body.id)
    expect(ids(await request(app).get('/api/v1/campaigns?limit=100').set('tenant_id', TENANT))).toContain(body.id)
    // The token's tenant wins over the header.
    expect(ids(await request(app).get('/api/v1/campaigns?limit=100').set('Authorization', otherUser).set('tenant_id', TENANT))).not.toContain(body.id)

    expect((await request(app).get(path).set('Authorization', otherUser)).status).toBe(404)
    expect((await request(app).get(`${path}/products`).set('tenant_id', randomUUID())).status).toBe(404)
    for (const res of [
      await request(app).patch(path).set('Authorization', otherManager).send({ title: 'Taken' }),
      await request(app).post(`${path}/products`).set('Authorization', otherManager).send({ productIds: [await knownProduct('Theirs', true, otherTenant)] }),
      await request(app).delete(`${path}/products/${body.productIds[0]}`).set('Authorization', otherManager),
      await request(app).delete(path).set('Authorization', otherManager),
    ]) {
      expect(res.body.error.code).toBe('CAMPAIGN_NOT_FOUND')
    }
    expect((await request(app).get(path).set('Authorization', manager)).body).toMatchObject({ title: 'Ours', archived: false, productIds: body.productIds })
  })

  it("can only use the manager's own tenant's products", async () => {
    const theirs = await knownProduct('Theirs', true, otherTenant)
    const res = await create({ title: 'Borrowed', placement: 'spotlight', productIds: [theirs] })
    expect(res.body.error).toMatchObject({ code: 'PRODUCT_NOT_YET_AVAILABLE', details: { productIds: [theirs] } })
    expect((await create({ title: 'Own', placement: 'spotlight', productIds: [theirs] }, otherManager)).status).toBe(201)
  })

  it('ignores product events from before products had tenants', async () => {
    const id = randomUUID()
    await applyProductEvent({ ...productEvent('ProductCreated', id, 1, productState('Old')), payload: { productId: id, ...productState('Old') } })
    expect((await db.$client.query('SELECT 1 FROM products WHERE product_id = $1', [id])).rowCount).toBe(0)
  })
})

describe('campaign products', () => {
  it('adds and removes products, rejecting duplicate associations', async () => {
    const [a, b] = [await knownProduct('A'), await knownProduct('B')]
    const { body: campaign } = await create({ title: 'Assoc', placement: 'spotlight', productIds: [a] })
    const path = `/api/v1/campaigns/${campaign.id}/products`

    const added = await request(app).post(path).set('Authorization', manager).send({ productIds: [b] })
    expect(added.status).toBe(201)
    expect(added.body.productIds).toEqual([a, b])

    const duplicate = await request(app).post(path).set('Authorization', manager).send({ productIds: [a] })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.error.code).toBe('DUPLICATE_ASSOCIATION')

    const listed = await request(app).get(path).set('Authorization', user)
    expect(listed.body.items.map((p: { productId: string; name: string }) => [p.productId, p.name])).toEqual([
      [a, 'A'],
      [b, 'B'],
    ])

    expect((await request(app).delete(`${path}/${a}`).set('Authorization', manager)).status).toBe(204)
    expect((await request(app).delete(`${path}/${a}`).set('Authorization', manager)).status).toBe(404)
    const removed = bus.published.filter((m) => m.key === campaign.id).at(-1)!.envelope
    expect(removed).toMatchObject({ eventType: 'CampaignProductRemoved', payload: { productId: a } })
    expect(removed.aggregateVersion).toBeGreaterThan(1)
  })
})

describe('updating and archiving', () => {
  it('follows the allowed status transitions', async () => {
    const { body } = await create({ title: 'Lifecycle', placement: 'spotlight' })
    const patch = (payload: object) => request(app).patch(`/api/v1/campaigns/${body.id}`).set('Authorization', manager).send(payload)
    expect((await patch({ status: 'paused' })).body.error.code).toBe('INVALID_STATUS_TRANSITION')
    expect((await patch({ status: 'active' })).body.status).toBe('active')
    expect((await patch({ status: 'paused' })).body.status).toBe('paused')
    expect((await patch({ status: 'completed' })).body.status).toBe('completed')
    expect((await patch({ status: 'active' })).status).toBe(422)
  })

  it('archives instead of deleting and blocks further changes', async () => {
    const { body } = await create({ title: 'To archive', placement: 'spotlight' })
    const archived = await request(app).delete(`/api/v1/campaigns/${body.id}`).set('Authorization', manager)
    expect(archived.body.archived).toBe(true)
    const event = bus.published.filter((m) => m.key === body.id).at(-1)!.envelope
    expect(event).toMatchObject({ eventType: 'CampaignUpdated', payload: { archived: true } })
    const edit = await request(app).patch(`/api/v1/campaigns/${body.id}`).set('Authorization', manager).send({ title: 'x' })
    expect(edit.body.error.code).toBe('CAMPAIGN_ARCHIVED')
    const list = await request(app).get('/api/v1/campaigns?limit=100').set('Authorization', user)
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(body.id)
  })
})

describe('who created and changed what', () => {
  const row = async (sql: string, ...params: string[]) => (await db.$client.query(sql, params)).rows[0]

  it("records the campaign's creator and last updater", async () => {
    const { body } = await create({ title: 'Audited', placement: 'spotlight' })
    expect(body).toMatchObject({ createdBy: managerId, updatedBy: managerId })
    const patched = await request(app).patch(`/api/v1/campaigns/${body.id}`).set('Authorization', colleague).send({ title: 'Edited' })
    expect(patched.body).toMatchObject({ createdBy: managerId, updatedBy: colleagueId })
    expect(
      await row('SELECT tenant_id, campaign_created_by, campaign_updated_by, campaign_updated_at > campaign_created_at AS changed FROM campaigns WHERE id = $1', body.id),
    ).toEqual({ tenant_id: TENANT, campaign_created_by: managerId, campaign_updated_by: colleagueId, changed: true })
  })

  it('records the tenant and who added each product to a campaign', async () => {
    const [a, b] = [await knownProduct('A'), await knownProduct('B')]
    const { body } = await create({ title: 'Assoc audit', placement: 'spotlight', productIds: [a] })
    await request(app).post(`/api/v1/campaigns/${body.id}/products`).set('Authorization', colleague).send({ productIds: [b] })
    const { rows } = await db.$client.query(
      'SELECT product_id, tenant_id, created_by, updated_by, updated_at = created_at AS unchanged FROM campaign_products WHERE campaign_id = $1 ORDER BY position',
      [body.id],
    )
    expect(rows).toEqual([
      { product_id: a, tenant_id: TENANT, created_by: managerId, updated_by: managerId, unchanged: true },
      { product_id: b, tenant_id: TENANT, created_by: colleagueId, updated_by: colleagueId, unchanged: true },
    ])
    expect(await row('SELECT campaign_updated_by FROM campaigns WHERE id = $1', body.id)).toEqual({ campaign_updated_by: colleagueId })
  })
})

describe('products copy (Kafka consumer)', () => {
  const read = async (id: string) =>
    (await db.$client.query('SELECT name, is_active, product_version::int AS product_version FROM products WHERE product_id = $1', [id])).rows[0]
  const actors = async (id: string) =>
    (await db.$client.query('SELECT tenant_id, created_at IS NOT NULL AS has_created_at, created_by, updated_by FROM products WHERE product_id = $1', [id])).rows[0]

  it("stores the product's tenant, creation time and creator and last updater", async () => {
    const id = await knownProduct('audited')
    expect(await actors(id)).toEqual({ tenant_id: TENANT, has_created_at: true, created_by: PRODUCT_ACTOR, updated_by: PRODUCT_ACTOR })
    const deactivator = randomUUID()
    await applyProductEvent(productEvent('ProductDeactivated', id, 2, { deactivatedAt: new Date().toISOString(), deactivatedBy: deactivator }))
    expect(await actors(id)).toMatchObject({ created_by: PRODUCT_ACTOR, updated_by: deactivator })
  })

  it('fills the new fields from a republished event of the same version', async () => {
    const id = randomUUID()
    const { createdAt: _a, createdBy: _c, updatedBy: _u, ...withoutActors } = productState('old event')
    await applyProductEvent(productEvent('ProductCreated', id, 1, withoutActors))
    expect(await actors(id)).toEqual({ tenant_id: TENANT, has_created_at: false, created_by: null, updated_by: null })
    await applyProductEvent(productEvent('ProductUpdated', id, 1, productState('old event')))
    expect(await actors(id)).toEqual({ tenant_id: TENANT, has_created_at: true, created_by: PRODUCT_ACTOR, updated_by: PRODUCT_ACTOR })
  })

  it('ignores stale and out-of-order versions', async () => {
    const id = randomUUID()
    await applyProductEvent(productEvent('ProductUpdated', id, 3, productState('v3')))
    await applyProductEvent(productEvent('ProductCreated', id, 1, productState('v1')))
    expect(await read(id)).toEqual({ name: 'v3', is_active: true, product_version: 3 })
  })

  it('records a deactivation that arrives before the creation', async () => {
    const id = randomUUID()
    await applyProductEvent(productEvent('ProductDeactivated', id, 2, { deactivatedAt: new Date().toISOString() }))
    await applyProductEvent(productEvent('ProductCreated', id, 1, productState('late')))
    expect(await read(id)).toMatchObject({ is_active: false, product_version: 2 })
  })

  it('ignores a redelivered event once a newer one is applied', async () => {
    const id = await knownProduct('original')
    const update = productEvent('ProductUpdated', id, 2, productState('renamed'))
    await applyProductEvent(update)
    await applyProductEvent(productEvent('ProductUpdated', id, 3, productState('renamed again')))
    await applyProductEvent(update)
    expect(await read(id)).toMatchObject({ name: 'renamed again', product_version: 3 })
  })

  it('has no processed_events table', async () => {
    expect((await db.$client.query("SELECT to_regclass('processed_events') AS t")).rows[0].t).toBeNull()
  })
})

describe('campaigns from before sellers (cli.ts republish)', () => {
  it("get their products' seller when all of them share one, and only then", async () => {
    const [a, b, theirs] = [await knownProduct('A'), await knownProduct('B'), await knownProduct('Theirs', true, TENANT, OTHER_SELLER)]
    const one = (await create({ title: 'One seller', placement: 'spotlight', productIds: [a, b] })).body.id as string
    const mixed = (await create({ title: 'Mixed', placement: 'spotlight', productIds: [a] })).body.id as string
    // As saved before sellers: no seller; the mixed one also got another seller's product.
    await db.$client.query('UPDATE campaigns SET seller_id = NULL WHERE id = ANY($1)', [[one, mixed]])
    await db.$client.query(
      "INSERT INTO campaign_products (id, tenant_id, campaign_id, product_id, position, created_by, updated_by) VALUES ($1, $2, $3, $4, 2, $5, $5)",
      [randomUUID(), TENANT, mixed, theirs, managerId],
    )

    expect(await fillCampaignSellers(db)).toBe(1)
    const sellers = await db.$client.query('SELECT id, seller_id FROM campaigns WHERE id = ANY($1)', [[one, mixed]])
    expect(Object.fromEntries(sellers.rows.map((row) => [row.id, row.seller_id]))).toEqual({ [one]: SELLER, [mixed]: null })
  })
})

describe('a store connected to Basketline (StoreConnected)', () => {
  it('keeps its sealed API key, creates the 2 planned active campaigns with their 2 and 3 products once, and sends them to Basketline', async () => {
    const tenantId = randomUUID()
    const connectedBy = randomUUID()
    const products = Array.from({ length: 5 }, () => randomUUID())
    const sellers = [randomUUID(), randomUUID()]
    const plan = [
      { campaignId: randomUUID(), sellerId: sellers[0]!, productIds: products.slice(0, 2) },
      { campaignId: randomUUID(), sellerId: sellers[1]!, productIds: products.slice(2) },
    ]
    const envelope: EventEnvelope = {
      eventId: randomUUID(),
      eventType: 'StoreConnected',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'retailer-auth-service',
      aggregateId: tenantId,
      aggregateVersion: 1,
      payload: {
        tenantId, name: 'Seed Co', sealedApiKey: sealSecret('bl_sk_store-key', SECRETS_KEY), connectedBy,
        seed: { productIds: [...products, randomUUID()], sellers: plan.map((p) => ({ sellerId: p.sellerId, name: 'Seller', productIds: p.productIds })), campaigns: plan },
      },
    }
    const connect = createStoreConnector({ db, publish: createEventPublisher(bus, 'campaign-service', createLogger('campaign-test'), { registry: RETAILER_EVENTS }), basketline })
    const sentBefore = sent.length
    await connect(envelope)
    await connect(envelope)
    expect(openSecret((await findSealedApiKey(db, tenantId))!, SECRETS_KEY)).toBe('bl_sk_store-key')

    const placements = await request(app).get('/api/v1/placements').set('tenant_id', tenantId)
    expect(placements.body.items.map((p: { key: string }) => p.key)).toEqual(['spotlight', 'top_rated', 'customer_picks', 'deals'])
    const list = await request(app).get('/api/v1/campaigns').set('tenant_id', tenantId)
    expect(list.body.page.total).toBe(2)
    const byId = new Map(list.body.items.map((c: { id: string }) => [c.id, c]))
    for (const [index, planned] of plan.entries()) {
      expect(byId.get(planned.campaignId)).toMatchObject({
        title: `Seed Co ${['Launch Deals', 'Weekend Picks'][index]}`,
        // The default placements, one after the other.
        placement: ['spotlight', 'top_rated'][index],
        status: 'active',
        archived: false,
        createdBy: connectedBy,
        sellerId: planned.sellerId,
        productIds: planned.productIds,
      })
    }
    const created = bus.published.filter((m) => plan.some((p) => p.campaignId === m.key)).map((m) => m.envelope.eventType)
    expect(created.filter((type) => type === 'CampaignCreated')).toHaveLength(2)
    expect(created.filter((type) => type === 'CampaignProductAssociated')).toHaveLength(5)
    // Once, with their products.
    const calls = sent.slice(sentBefore)
    expect(calls.map((c) => [c.tenantId, c.call, c.records.map((r) => r.productIds)])).toEqual([[tenantId, 'campaigns.upsert', plan.map((p) => p.productIds)]])
  })
})

describe('placements (the marketplace\'s sections)', () => {
  it('lists the active ones in order to anyone; staff add, rename, reorder and turn them off; a campaign needs an active one', async () => {
    const list = async (auth?: string, query = '') => {
      const req = request(app).get(`/api/v1/placements${query}`)
      return (await (auth ? req.set('Authorization', auth) : req.set('tenant_id', TENANT))).body.items.map((p: { key: string }) => p.key)
    }
    expect(await list()).toEqual(expect.arrayContaining(['spotlight', 'top_rated', 'customer_picks', 'deals']))
    expect((await request(app).post('/api/v1/placements').set('Authorization', seller).send({ key: 'new_in', name: 'New in', position: 5 })).status).toBe(403)
    const added = await request(app).post('/api/v1/placements').set('Authorization', manager).send({ key: 'new_in', name: 'New in', position: 0 })
    expect(added.status).toBe(201)
    expect((await list())[0]).toBe('new_in')
    expect((await request(app).post('/api/v1/placements').set('Authorization', manager).send({ key: 'new_in', name: 'Again', position: 1 })).status).toBe(409)
    expect((await request(app).post('/api/v1/placements').set('Authorization', manager).send({ key: 'Bad Key', name: 'x', position: 1 })).status).toBe(400)

    expect((await create({ title: 'In new', placement: 'new_in' })).status).toBe(201)
    expect((await request(app).patch('/api/v1/placements/new_in').set('Authorization', manager).send({ active: false, name: 'New arrivals' })).body).toMatchObject({ name: 'New arrivals', active: false })
    expect(await list()).not.toContain('new_in')
    expect(await list(manager, '?all=true')).toContain('new_in')
    const inactive = await create({ title: 'Too late', placement: 'new_in' })
    expect(inactive.status).toBe(422)
    expect(inactive.body.error.code).toBe('PLACEMENT_UNAVAILABLE')
    expect((await create({ title: 'Nowhere', placement: 'nowhere' })).status).toBe(422)
    expect((await request(app).patch('/api/v1/placements/nowhere').set('Authorization', manager).send({ name: 'x' })).status).toBe(404)
  })
})

describe('sellers (the seller portal)', () => {
  it('create campaigns for themselves only, and change only their own', async () => {
    const ours = await knownProduct('Ours')
    const res = await create({ title: 'Mine', placement: 'top_rated', status: 'active', productIds: [ours], sellerId: undefined }, seller)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ sellerId: SELLER, placement: 'top_rated' })
    expect((await create({ title: 'For another', placement: 'spotlight' }, otherSeller)).status).toBe(403)

    const id = res.body.id as string
    expect((await request(app).patch(`/api/v1/campaigns/${id}`).set('Authorization', otherSeller).send({ title: 'Taken' })).status).toBe(404)
    expect((await request(app).delete(`/api/v1/campaigns/${id}/products/${ours}`).set('Authorization', otherSeller)).status).toBe(404)
    expect((await request(app).patch(`/api/v1/campaigns/${id}`).set('Authorization', seller).send({ status: 'paused', placement: 'deals' })).body).toMatchObject({ status: 'paused', placement: 'deals' })

    const mine = await request(app).get(`/api/v1/campaigns?sellerId=${SELLER}`).set('Authorization', seller)
    expect(mine.body.items.every((c: { sellerId: string }) => c.sellerId === SELLER)).toBe(true)
    expect(mine.body.items.map((c: { id: string }) => c.id)).toContain(id)
  })

  it('send the products they add and take out to Basketline, with their details, and again when the details change', async () => {
    const [a, b] = [await knownProduct('Earbuds'), await knownProduct('Cable')]
    const before = sent.length
    const { body } = await create({ title: 'Sent', placement: 'spotlight', productIds: [a], sellerId: undefined }, seller)
    await request(app).post(`/api/v1/campaigns/${body.id}/products`).set('Authorization', seller).send({ productIds: [b] })
    await request(app).delete(`/api/v1/campaigns/${body.id}/products/${a}`).set('Authorization', seller)
    const calls = sent.slice(before).filter((c) => c.call !== 'campaigns.upsert')
    expect(calls.map((c) => [c.call, c.records])).toEqual([
      ['campaigns.addProducts', [{ campaignId: body.id, productId: a, sellerId: SELLER, productName: 'Earbuds', productPrice: 999, category: 'Audio' }]],
      ['campaigns.addProducts', [{ campaignId: body.id, productId: b, sellerId: SELLER, productName: 'Cable', productPrice: 999, category: 'Audio' }]],
      ['campaigns.removeProducts', [{ campaignId: body.id, productId: a }]],
    ])
    expect(sent.findLast((c) => c.call === 'campaigns.upsert')!.records[0]).toMatchObject({ campaignId: body.id, placement: 'spotlight' })

    // b is renamed: its campaign product goes again, with the new name.
    const afterAdd = sent.length
    await applyProductEvent(productEvent('ProductUpdated', b, 2, productState('Braided cable')))
    expect(sent.slice(afterAdd).map((c) => [c.call, c.records])).toEqual([
      ['campaigns.addProducts', [{ campaignId: body.id, productId: b, sellerId: SELLER, productName: 'Braided cable', productPrice: 999, category: 'Audio' }]],
    ])
  })

  it("see their campaign's totals and results per product from Basketline (their store), with zeros for products without activity", async () => {
    const [a, b] = [await knownProduct('Earbuds'), await knownProduct('Cable')]
    const { body } = await create({ title: 'Results', placement: 'spotlight', productIds: [a, b], sellerId: undefined }, seller)
    results.splice(0, results.length, { productId: a, name: 'Earbuds', category: 'Audio', price: 999, impressions: 10, clicks: 2, ctr: 0.2, addToCarts: 1, clickToBasket: 0.5 })
    Object.assign(metrics, {
      impressions: { count: 10, total_web_impressions: 7, total_mobile_impressions: 3, customers_visitor_impressions: 5, customers_registered_impressions: 2 },
      clicks: { count: 2, total_web_clicks: 2, total_mobile_clicks: 0, customers_visitor_clicks: 1, customers_registered_clicks: 1 },
      clickToBasket: { count: 1, total_web_click_to_basket: 1, total_mobile_click_to_basket: 0, customers_visitor_click_to_basket: 0, customers_registered_click_to_basket: 1 },
      uniqueCustomers: { count: 7, has_visited_in_web: 5, has_visited_in_mobile: 3, has_visited_in_both: 1, has_visited_visitor: 6, has_visited_registered: 2 },
      sessions: { count: 8, total_converted_sessions: 1, total_web_sessions: 6, total_mobile_sessions: 2 },
    })
    try {
      const res = await request(app).get(`/api/v1/campaigns/${body.id}/results?from=2026-10-01T00:00:00Z`).set('Authorization', seller)
      expect(res.status).toBe(200)
      expect(res.body.totals).toEqual({ impressions: 10, clicks: 2, ctr: 0.2, addToCarts: 1, clickToBasket: 0.5, uniqueCustomers: 7, sessions: 8, convertedSessions: 1 })
      expect(res.body.byClient).toEqual({
        web: { impressions: 7, clicks: 2, addToCarts: 1, customers: 5, sessions: 6 },
        mobile: { impressions: 3, clicks: 0, addToCarts: 0, customers: 3, sessions: 2 },
      })
      expect(res.body.bothClients).toBe(1)
      expect(res.body.byUserType).toEqual({
        visitor: { customers: 6, viewed: 5, clicked: 1, addedToCart: 0 },
        registered: { customers: 2, viewed: 2, clicked: 1, addedToCart: 1 },
      })
      // 6 + 2 - 7: one browsed signed out, then signed in.
      expect(res.body.bothUserTypes).toBe(1)
      expect(res.body.items).toEqual([
        { productId: a, name: 'Earbuds', category: 'Audio', price: 999, impressions: 10, clicks: 2, ctr: 0.2, addToCarts: 1, clickToBasket: 0.5 },
        { productId: b, name: 'Cable', category: 'Audio', price: 999, impressions: 0, clicks: 0, ctr: 0, addToCarts: 0, clickToBasket: 0 },
      ])
      expect(sent.findLast((c) => c.call === 'insights.campaignProducts')!.records[0]).toEqual({ campaignId: body.id, storeId: SELLER, from: '2026-10-01T00:00:00Z', to: undefined })
    } finally {
      results.splice(0, results.length)
      for (const metric of Object.keys(metrics)) delete metrics[metric]
    }
    expect((await request(app).get(`/api/v1/campaigns/${body.id}/results`).set('Authorization', otherSeller)).status).toBe(404)
    expect((await request(app).get(`/api/v1/campaigns/${body.id}/results`).set('Authorization', manager)).status).toBe(200)
    expect((await request(app).get(`/api/v1/campaigns/${body.id}/results`).set('Authorization', user)).status).toBe(403)
  })
})
