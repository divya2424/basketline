import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '@ecommerce-analytics/contracts'
import { closeDb, createEventPublisher, createLogger, createMemoryEventBus, type MemoryEventBus } from '@ecommerce-analytics/platform'
import { createTestDatabase, createTestKeys, tokenFor } from '@ecommerce-analytics/platform/testing'
import { buildCampaignApp } from '../src/app.ts'
import { createCampaignDb, migrateCampaignDb, type Db } from '../src/db/client.ts'
import { handleProductEvent } from '../src/events/product.consumer.ts'
import { createTenantSeeder } from '../src/events/tenant.consumer.ts'

let testDb: Awaited<ReturnType<typeof createTestDatabase>>
let db: Db
let bus: MemoryEventBus
let app: ReturnType<typeof buildCampaignApp>
const TENANT = '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01'
let manager: string
let managerId: string
// Another manager of the same tenant.
let colleague: string
let colleagueId: string
let user: string
let otherManager: string
let otherUser: string
let otherTenant: string
let applyProductEvent: (envelope: EventEnvelope) => Promise<void>

beforeAll(async () => {
  testDb = await createTestDatabase()
  db = createCampaignDb(testDb.url)
  await migrateCampaignDb(db)
  const keys = await createTestKeys()
  const logger = createLogger('campaign-test')
  bus = createMemoryEventBus(logger)
  app = buildCampaignApp({ db, bus, logger, publicKey: keys.publicKey })
  const managerToken = await tokenFor(keys, 'campaign-manager', { tid: TENANT })
  manager = managerToken.header
  managerId = managerToken.sub
  const colleagueToken = await tokenFor(keys, 'campaign-manager', { tid: TENANT })
  colleague = colleagueToken.header
  colleagueId = colleagueToken.sub
  user = (await tokenFor(keys, 'standard-user', { tid: TENANT })).header
  otherTenant = randomUUID()
  otherManager = (await tokenFor(keys, 'campaign-manager', { tid: otherTenant })).header
  otherUser = (await tokenFor(keys, 'standard-user', { tid: otherTenant })).header
  applyProductEvent = (envelope) => handleProductEvent(db, envelope)
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
const productState = (name: string, isActive = true) => ({
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
async function knownProduct(name = 'Product', isActive = true, tenantId = TENANT) {
  const id = randomUUID()
  await applyProductEvent(productEvent('ProductCreated', id, 1, productState(name, isActive), randomUUID(), tenantId))
  return id
}

const create = (body: object, auth = manager) => request(app).post('/api/v1/campaigns').set('Authorization', auth).send(body)
const campaignCount = async () => (await db.$client.query('SELECT count(*)::int AS n FROM campaigns')).rows[0].n as number

describe('creating campaigns', () => {
  it('saves the campaign with its products in order and publishes the events', async () => {
    const [a, b] = [await knownProduct('A'), await knownProduct('B')]
    const res = await create({
      title: 'Festive Electronics Sale',
      type: 'seasonal',
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
    expect(bus.published.every((m) => m.topic === 'campaign.v1')).toBe(true)
  })

  it('returns a retryable 409 for products the projection has not seen yet', async () => {
    const before = await campaignCount()
    const unknown = randomUUID()
    const res = await create({ title: 'Too early', type: 'seasonal', productIds: [unknown] })
    expect(res.status).toBe(409)
    expect(res.headers['retry-after']).toBe('5')
    expect(res.body.error).toMatchObject({ code: 'PRODUCT_NOT_YET_AVAILABLE', details: { retryable: true, productIds: [unknown] } })
    expect(await campaignCount()).toBe(before)
  })

  it('rejects inactive products and rolls back the whole campaign', async () => {
    const before = await campaignCount()
    const publishedBefore = bus.published.length
    const res = await create({ title: 'Has inactive', type: 'x', productIds: [await knownProduct('ok'), await knownProduct('off', false)] })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('PRODUCT_INACTIVE')
    expect(await campaignCount()).toBe(before)
    expect(bus.published.length).toBe(publishedBefore)
  })

  it('rejects duplicate product IDs in the request', async () => {
    const id = await knownProduct()
    const res = await create({ title: 'Dupes', type: 'x', productIds: [id, id] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DUPLICATE_PRODUCT_IDS')
  })

  it('validates fields and schedules', async () => {
    const bad = await create({ title: '', type: 'x', status: 'completed', startTime: 'tomorrow', extra: 1 })
    expect(bad.status).toBe(400)
    expect(bad.body.error.details.errors).toEqual(
      expect.arrayContaining(['unknown field "extra"', 'title is required (max 255 characters)', 'status must be "draft" or "active" when creating']),
    )
    const backwards = await create({ title: 'T', type: 'x', startTime: '2026-11-15T00:00:00Z', endTime: '2026-11-01T00:00:00Z' })
    expect(backwards.body.error.code).toBe('INVALID_SCHEDULE')
  })

  it('forbids standard users from creating or changing campaigns; anyone can read', async () => {
    expect((await create({ title: 'Nope', type: 'x' }, user)).status).toBe(403)
    const { body } = await create({ title: 'Readable', type: 'x' })
    expect((await request(app).patch(`/api/v1/campaigns/${body.id}`).set('Authorization', user).send({ title: 'x' })).status).toBe(403)
    expect((await request(app).get(`/api/v1/campaigns/${body.id}`).set('Authorization', user)).status).toBe(200)
    expect((await request(app).get('/api/v1/campaigns').set('tenant_id', TENANT)).status).toBe(200)
    expect((await request(app).get('/api/v1/campaigns')).body.error.code).toBe('TENANT_REQUIRED')
    expect((await request(app).post('/api/v1/campaigns').send({ title: 'x', type: 'y' })).status).toBe(401)
  })
})

describe('tenants', () => {
  it("shows, changes and lists only the caller's tenant's campaigns", async () => {
    const { body } = await create({ title: 'Ours', type: 'x', productIds: [await knownProduct()] })
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
    const res = await create({ title: 'Borrowed', type: 'x', productIds: [theirs] })
    expect(res.body.error).toMatchObject({ code: 'PRODUCT_NOT_YET_AVAILABLE', details: { productIds: [theirs] } })
    expect((await create({ title: 'Own', type: 'x', productIds: [theirs] }, otherManager)).status).toBe(201)
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
    const { body: campaign } = await create({ title: 'Assoc', type: 'x', productIds: [a] })
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
    const { body } = await create({ title: 'Lifecycle', type: 'x' })
    const patch = (payload: object) => request(app).patch(`/api/v1/campaigns/${body.id}`).set('Authorization', manager).send(payload)
    expect((await patch({ status: 'paused' })).body.error.code).toBe('INVALID_STATUS_TRANSITION')
    expect((await patch({ status: 'active' })).body.status).toBe('active')
    expect((await patch({ status: 'paused' })).body.status).toBe('paused')
    expect((await patch({ status: 'completed' })).body.status).toBe('completed')
    expect((await patch({ status: 'active' })).status).toBe(422)
  })

  it('archives instead of deleting and blocks further changes', async () => {
    const { body } = await create({ title: 'To archive', type: 'x' })
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
    const { body } = await create({ title: 'Audited', type: 'x' })
    expect(body).toMatchObject({ createdBy: managerId, updatedBy: managerId })
    const patched = await request(app).patch(`/api/v1/campaigns/${body.id}`).set('Authorization', colleague).send({ title: 'Edited' })
    expect(patched.body).toMatchObject({ createdBy: managerId, updatedBy: colleagueId })
    expect(
      await row('SELECT tenant_id, campaign_created_by, campaign_updated_by, campaign_updated_at > campaign_created_at AS changed FROM campaigns WHERE id = $1', body.id),
    ).toEqual({ tenant_id: TENANT, campaign_created_by: managerId, campaign_updated_by: colleagueId, changed: true })
  })

  it('records the tenant and who added each product to a campaign', async () => {
    const [a, b] = [await knownProduct('A'), await knownProduct('B')]
    const { body } = await create({ title: 'Assoc audit', type: 'x', productIds: [a] })
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

describe('seeding an onboarded tenant (TenantOnboarded)', () => {
  it('creates the 2 planned active campaigns with their 2 and 3 products, once', async () => {
    const tenantId = randomUUID()
    const onboardedBy = randomUUID()
    const products = Array.from({ length: 5 }, () => randomUUID())
    const plan = [
      { campaignId: randomUUID(), productIds: products.slice(0, 2) },
      { campaignId: randomUUID(), productIds: products.slice(2) },
    ]
    const envelope: EventEnvelope = {
      eventId: randomUUID(),
      eventType: 'TenantOnboarded',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'auth-service',
      aggregateId: tenantId,
      aggregateVersion: 1,
      payload: { tenantId, name: 'Seed Co', tier: 'pro', onboardedBy, seed: { productIds: [...products, randomUUID()], campaigns: plan } },
    }
    const seed = createTenantSeeder({ db, publish: createEventPublisher(bus, 'campaign-service', createLogger('campaign-test')) })
    await seed(envelope)
    await seed(envelope)

    const list = await request(app).get('/api/v1/campaigns').set('tenant_id', tenantId)
    expect(list.body.page.total).toBe(2)
    const byId = new Map(list.body.items.map((c: { id: string }) => [c.id, c]))
    for (const [index, planned] of plan.entries()) {
      expect(byId.get(planned.campaignId)).toMatchObject({
        title: `Seed Co ${['Launch Deals', 'Weekend Picks'][index]}`,
        type: 'product_collection',
        status: 'active',
        archived: false,
        createdBy: onboardedBy,
        productIds: planned.productIds,
      })
    }
    const created = bus.published.filter((m) => plan.some((p) => p.campaignId === m.key)).map((m) => m.envelope.eventType)
    expect(created.filter((type) => type === 'CampaignCreated')).toHaveLength(2)
    expect(created.filter((type) => type === 'CampaignProductAssociated')).toHaveLength(5)
  })
})
