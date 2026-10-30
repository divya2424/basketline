import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, createEventPublisher, createLogger, createMemoryEventBus, type MemoryEventBus } from '@basketline/platform'
import { createTestDatabase, createTestKeys, tokenFor, type TestKeys } from '@basketline/platform/testing'
import { buildProductApp } from '../src/app.ts'
import { createProductDb, migrateProductDb, type Db } from '../src/db/client.ts'
import { createTenantSeeder, handleTenantDeleted } from '../src/events/tenant.consumer.ts'

let testDb: Awaited<ReturnType<typeof createTestDatabase>>
let db: Db
let keys: TestKeys
let app: ReturnType<typeof buildProductApp>
let bus: MemoryEventBus
const TENANT = '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01'
let manager: string
let managerId: string
// Another manager of the same tenant.
let colleague: string
let colleagueId: string
let user: string
let otherManager: string
let otherUser: string

const sample = { name: 'Aurora Wireless Earbuds', description: 'ANC earbuds', price: 2999, image: '/images/aurora-earbuds.svg', category: 'Audio' }

beforeAll(async () => {
  testDb = await createTestDatabase()
  db = createProductDb(testDb.url)
  await migrateProductDb(db)
  keys = await createTestKeys()
  const logger = createLogger('product-test')
  bus = createMemoryEventBus(logger)
  app = buildProductApp({ db, bus, logger, publicKey: keys.publicKey })
  const managerToken = await tokenFor(keys, 'campaign-manager', { tid: TENANT })
  manager = managerToken.header
  managerId = managerToken.sub
  const colleagueToken = await tokenFor(keys, 'campaign-manager', { tid: TENANT })
  colleague = colleagueToken.header
  colleagueId = colleagueToken.sub
  user = (await tokenFor(keys, 'standard-user', { tid: TENANT })).header
  const otherTenant = randomUUID()
  otherManager = (await tokenFor(keys, 'campaign-manager', { tid: otherTenant })).header
  otherUser = (await tokenFor(keys, 'standard-user', { tid: otherTenant })).header
})

afterAll(async () => {
  await closeDb(db)
  await testDb.drop()
})

const create = (body: object = sample, auth = manager) => request(app).post('/api/v1/products').set('Authorization', auth).send(body)
const events = (productId: string) => bus.published.filter((m) => m.key === productId).map((m) => m.envelope)

describe('products', () => {
  it('lets a campaign manager create a product with frontend-compatible fields and emits ProductCreated', async () => {
    const res = await create()
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ ...sample, isActive: true })
    expect(typeof res.body.price).toBe('number')
    expect(res.headers.location).toBe(`/api/v1/products/${res.body.id}`)
    const [created] = events(res.body.id)
    expect(created).toMatchObject({ eventType: 'ProductCreated', aggregateVersion: 1, producer: 'product-service', payload: { productId: res.body.id, tenantId: TENANT, price: 2999 } })
  })

  it('records who created and last changed the product, and puts it in the events', async () => {
    const { body: created } = await create()
    expect(created).toMatchObject({ createdBy: managerId, updatedBy: managerId })
    const patched = await request(app).patch(`/api/v1/products/${created.id}`).set('Authorization', colleague).send({ price: 1999 })
    expect(patched.body).toMatchObject({ createdBy: managerId, updatedBy: colleagueId })
    await request(app).delete(`/api/v1/products/${created.id}`).set('Authorization', manager)
    const [createdEvent, updatedEvent, deactivatedEvent] = events(created.id)
    expect(createdEvent!.payload).toMatchObject({ createdAt: created.createdAt, createdBy: managerId, updatedBy: managerId })
    expect(updatedEvent!.payload).toMatchObject({ createdAt: created.createdAt, createdBy: managerId, updatedBy: colleagueId })
    expect(deactivatedEvent!.payload).toMatchObject({ deactivatedBy: managerId })
    const { rows } = await db.$client.query('SELECT created_by, updated_by FROM products WHERE id = $1', [created.id])
    expect(rows[0]).toEqual({ created_by: managerId, updated_by: managerId })
  })

  it('forbids standard users from writing; anyone can read', async () => {
    expect((await create(sample, user)).status).toBe(403)
    expect((await create(sample, '')).status).toBe(401)
    expect((await request(app).get('/api/v1/products').set('tenant_id', TENANT)).status).toBe(200)
    expect((await request(app).get('/api/v1/products')).body.error.code).toBe('TENANT_REQUIRED')
    expect((await request(app).get('/api/v1/products').set('Authorization', user)).status).toBe(200)
  })

  it('validates mandatory fields and prices', async () => {
    for (const body of [
      { ...sample, name: '' },
      { ...sample, description: undefined },
      { ...sample, price: 0 },
      { ...sample, price: -5 },
      { ...sample, price: 10.999 },
      { ...sample, image: 'javascript:alert(1)' },
      { ...sample, sku: 'extra' },
    ]) {
      const res = await create(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('updates fields while keeping the same ID, bumping the version', async () => {
    const { body: created } = await create()
    const res = await request(app).patch(`/api/v1/products/${created.id}`).set('Authorization', manager).send({ price: 2499.5, category: null })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: created.id, price: 2499.5, category: null, name: sample.name })
    const updated = events(created.id).at(-1)
    expect(updated).toMatchObject({ eventType: 'ProductUpdated', aggregateVersion: 2, payload: { price: 2499.5, category: null } })
  })

  it('deactivates instead of deleting, hides inactive products by default, and can reactivate', async () => {
    const { body: created } = await create({ ...sample, name: 'To deactivate' })
    const del = await request(app).delete(`/api/v1/products/${created.id}`).set('Authorization', manager)
    expect(del.status).toBe(200)
    expect(del.body.isActive).toBe(false)
    expect(events(created.id).at(-1)).toMatchObject({ eventType: 'ProductDeactivated', aggregateVersion: 2, payload: { tenantId: TENANT } })

    const { rows } = await db.$client.query('SELECT count(*)::int AS n FROM products WHERE id = $1', [created.id])
    expect(rows[0].n).toBe(1)
    const list = await request(app).get('/api/v1/products?limit=100').set('Authorization', user)
    expect(list.body.items.map((p: { id: string }) => p.id)).not.toContain(created.id)
    const asManager = await request(app).get('/api/v1/products?limit=100&includeInactive=true').set('Authorization', manager)
    expect(asManager.body.items.map((p: { id: string }) => p.id)).toContain(created.id)
    // includeInactive is ignored for everyone else.
    const asVisitor = await request(app).get('/api/v1/products?limit=100&includeInactive=true').set('tenant_id', TENANT)
    expect(asVisitor.body.items.map((p: { id: string }) => p.id)).not.toContain(created.id)

    const again = await request(app).delete(`/api/v1/products/${created.id}`).set('Authorization', manager)
    expect(again.status).toBe(200)
    expect(events(created.id).length).toBe(2)

    const reactivated = await request(app).patch(`/api/v1/products/${created.id}`).set('Authorization', manager).send({ isActive: true })
    expect(reactivated.body.isActive).toBe(true)
    const rejectFalse = await request(app).patch(`/api/v1/products/${created.id}`).set('Authorization', manager).send({ isActive: false })
    expect(rejectFalse.status).toBe(400)
  })

  it('paginates and filters by category', async () => {
    await create({ ...sample, name: 'Filter me', category: 'Filtered' })
    await create({ ...sample, name: 'Filter me too', category: 'Filtered' })
    const res = await request(app).get('/api/v1/products?category=Filtered&limit=1').set('Authorization', user)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.page).toEqual({ limit: 1, offset: 0, total: 2 })
    expect((await request(app).get('/api/v1/products?limit=500').set('Authorization', user)).status).toBe(400)
  })

  it("shows, changes and lists only the caller's tenant's products", async () => {
    const { body: created } = await create({ ...sample, name: 'Ours' })
    const path = `/api/v1/products/${created.id}`
    const ids = (res: request.Response) => res.body.items.map((p: { id: string }) => p.id)
    expect(ids(await request(app).get('/api/v1/products?limit=100').set('tenant_id', TENANT))).toContain(created.id)
    // The token's tenant wins over the header.
    expect(ids(await request(app).get('/api/v1/products?limit=100').set('Authorization', otherUser).set('tenant_id', TENANT))).not.toContain(created.id)
    expect((await request(app).get(path).set('tenant_id', randomUUID())).status).toBe(404)
    expect((await request(app).patch(path).set('Authorization', otherManager).send({ price: 1 })).body.error.code).toBe('PRODUCT_NOT_FOUND')
    expect((await request(app).delete(path).set('Authorization', otherManager)).body.error.code).toBe('PRODUCT_NOT_FOUND')
    expect((await request(app).get(path).set('Authorization', manager)).body).toMatchObject({ name: 'Ours', price: sample.price, isActive: true })
  })

  it('returns 404 for unknown products and 400 for malformed IDs', async () => {
    expect((await request(app).get('/api/v1/products/00000000-0000-4000-8000-000000000000').set('Authorization', user)).status).toBe(404)
    expect((await request(app).get('/api/v1/products/not-a-uuid').set('Authorization', user)).status).toBe(400)
  })
})

describe('seeding an onboarded tenant (TenantOnboarded)', () => {
  it('creates the planned products once, as the onboarding user, and announces each', async () => {
    const tenantId = randomUUID()
    const onboardedBy = randomUUID()
    const productIds = Array.from({ length: 12 }, () => randomUUID())
    const envelope = {
      eventId: randomUUID(),
      eventType: 'TenantOnboarded',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'auth-service',
      aggregateId: tenantId,
      aggregateVersion: 1,
      payload: { tenantId, name: 'Seed Co', tier: 'free', onboardedBy, seed: { productIds, campaigns: [] } },
    }
    const seed = createTenantSeeder({ db, publish: createEventPublisher(bus, 'product-service', createLogger('product-test')) })
    await seed(envelope)
    await seed(envelope)

    const { rows } = await db.$client.query('SELECT id, name, created_by, updated_by, is_active FROM products WHERE tenant_id = $1', [tenantId])
    expect(rows.map((row) => row.id).sort()).toEqual([...productIds].sort())
    expect(new Set(rows.map((row) => row.name)).size).toBe(12)
    expect(rows.every((row) => row.created_by === onboardedBy && row.updated_by === onboardedBy && row.is_active)).toBe(true)
    const announced = productIds.flatMap((id) => events(id))
    expect(announced).toHaveLength(12)
    expect(announced.every((e) => e.eventType === 'ProductCreated' && (e.payload as { tenantId: string }).tenantId === tenantId)).toBe(true)

    const list = await request(app).get('/api/v1/products?limit=100').set('tenant_id', tenantId)
    expect(list.body.page.total).toBe(12)

    // TenantDeleted: all of them go (and only this tenant's).
    const otherProducts = (await db.$client.query('SELECT count(*)::int AS n FROM products WHERE tenant_id <> $1', [tenantId])).rows[0].n
    await handleTenantDeleted(db, { ...envelope, eventId: randomUUID(), eventType: 'TenantDeleted', aggregateVersion: 2, payload: { tenantId, name: 'Seed Co', deletedAt: new Date().toISOString() } })
    expect((await request(app).get('/api/v1/products?limit=100').set('tenant_id', tenantId)).body.page.total).toBe(0)
    expect((await db.$client.query('SELECT count(*)::int AS n FROM products WHERE tenant_id <> $1', [tenantId])).rows[0].n).toBe(otherProducts)
  })
})
