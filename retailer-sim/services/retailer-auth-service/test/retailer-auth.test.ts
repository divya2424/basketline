import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, createLogger, createMemoryEventBus, type MemoryEventBus } from '@basketline/platform'
import { createTestDatabase, createTestKeys, type TestKeys } from '@basketline/platform/testing'
import { createBasketlineClient, openSecret, verifyRetailerToken, type StoreConnectedPayload } from '@retailer-sim/shared'
import { buildRetailerAuthApp } from '../src/app.ts'
import { createRetailerAuthDb, migrateRetailerAuthDb, type Db } from '../src/db/client.ts'

const SECRETS_KEY = Buffer.alloc(32, 9).toString('base64')
const logger = createLogger('retailer-auth-test')
let testDb: Awaited<ReturnType<typeof createTestDatabase>>
let db: Db
let keys: TestKeys
let bus: MemoryEventBus
let app: ReturnType<typeof buildRetailerAuthApp>

/** What Basketline was asked (path, headers, body), and whether it is up. */
const calls: { path: string; headers: Headers; body: Record<string, unknown> }[] = []
let basketlineDown = false

/** A stand-in for Basketline's public API: onboarding and shopper tokens, checking the API key. */
const fakeBasketline: typeof fetch = async (input, init) => {
  if (basketlineDown) throw new TypeError('fetch failed')
  const path = new URL(String(input)).pathname.replace('/api/v1', '')
  const headers = new Headers(init?.headers)
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>
  calls.push({ path, headers, body })
  const json = (status: number, value: object) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  if (path === '/accounts') {
    if (body.name === 'Taken') return json(400, { error: { code: 'VALIDATION_FAILED', message: 'Request validation failed' } })
    const tenantId = randomUUID()
    const users = [{ username: 'onboarding', role: 'campaign-manager' }, ...(body.sellerManagers as { username: string }[]).map(({ username }) => ({ username, role: 'seller-manager' }))]
    return json(201, { account: { tenantId, name: body.name, tier: body.tier }, users, password: 'test', apiKey: { key: `bl_sk_key-of-${tenantId}`, prefix: 'bl_sk_key-of' } })
  }
  if (path === '/auth/shopper-token') {
    if (headers.get('authorization') !== `ApiKey bl_sk_key-of-${headers.get('tenant_id')}`) return json(401, { error: { code: 'INVALID_API_KEY', message: 'bad key' } })
    return json(201, { shopperToken: `shopper-for-${body.customerId}`, expiresIn: 1800, userId: body.visitorId ?? randomUUID() })
  }
  return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  db = createRetailerAuthDb(testDb.url)
  await migrateRetailerAuthDb(db)
  keys = await createTestKeys()
  bus = createMemoryEventBus(logger)
  const basketline = createBasketlineClient({ apiUrl: 'http://basketline.test/api/v1', fetch: fakeBasketline })
  app = buildRetailerAuthApp({ db, bus, logger, privateKey: keys.privateKey, publicKey: keys.publicKey, basketline, secretsKey: SECRETS_KEY, loginRateLimit: 5 })
})

afterAll(async () => {
  await closeDb(db)
  await testDb.drop()
})

const connect = (body: object = { name: 'Acme Store', tier: 'pro' }) => request(app).post('/api/v1/stores').send(body)
const login = (tenantId: string, username: string, extra: object = {}) =>
  request(app).post('/api/v1/auth/login').set('tenant_id', tenantId).send({ username, password: 'test', ...extra })

describe('connecting a store to Basketline', () => {
  it('onboards it through the public API, keeps its API key sealed, creates its logins and announces it', async () => {
    const res = await connect()
    expect(res.status).toBe(201)
    const { tenantId } = res.body.store
    expect(res.body).toMatchObject({
      store: { tenantId, name: 'Acme Store', tier: 'pro' },
      password: 'test',
      basketlineUsers: [{ username: 'onboarding' }, { username: 'seller01', role: 'seller-manager' }],
      basketlinePassword: 'test',
    })
    expect(res.body.users.map((u: { username: string }) => u.username)).toEqual(['staff', ...Array.from({ length: 10 }, (_, i) => `user${String(i + 1).padStart(2, '0')}`)])
    expect(JSON.stringify(res.body)).not.toContain('bl_sk_')

    // The key is only ever kept sealed: in the database and on Kafka.
    const { rows } = await db.$client.query('SELECT sealed_api_key FROM stores WHERE tenant_id = $1', [tenantId])
    expect(rows[0].sealed_api_key).not.toContain('bl_sk_')
    expect(openSecret(rows[0].sealed_api_key, SECRETS_KEY)).toBe(`bl_sk_key-of-${tenantId}`)
    const message = bus.published.find((m) => m.envelope.eventType === 'StoreConnected' && m.key === tenantId)!
    expect(message.topic).toBe('retailer.store.v1')
    const payload = message.envelope.payload as StoreConnectedPayload
    expect(JSON.stringify(payload)).not.toContain('bl_sk_')
    expect(openSecret(payload.sealedApiKey, SECRETS_KEY)).toBe(`bl_sk_key-of-${tenantId}`)
    expect(payload.seed.campaigns.map((c) => c.productIds.length)).toEqual([2, 3])
    // seller01 at Basketline manages the first seeded seller.
    const onboarding = calls.findLast((c) => c.path === '/accounts')!
    expect(onboarding.body).toEqual({ name: 'Acme Store', tier: 'pro', sellerManagers: [{ username: 'seller01', sellerId: payload.seed.sellers[0]!.sellerId }] })
    const staff = await login(tenantId, 'staff')
    expect(payload.connectedBy).toBe(staff.body.user.id)

    expect((await request(app).get('/api/v1/stores')).body.items[0]).toEqual({ tenantId, name: 'Acme Store', tier: 'pro', createdAt: expect.any(String) })
  })

  it("passes Basketline's refusals on, and says when it can't be reached", async () => {
    expect((await connect({ name: 'Taken', tier: 'free' })).body.error.code).toBe('VALIDATION_FAILED')
    basketlineDown = true
    try {
      const res = await connect({ name: 'Offline', tier: 'free' })
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('BASKETLINE_UNAVAILABLE')
    } finally {
      basketlineDown = false
    }
    expect((await connect({ name: 'x', tier: 'gold' })).status).toBe(400)
    expect((await connect({ name: 'x', tier: 'free', tenantId: randomUUID() })).status).toBe(400)
  })
})

describe('signing in', () => {
  it("gives a customer the store's token and a Basketline shopper token, asked for with the store's API key", async () => {
    const { tenantId } = (await connect({ name: 'Shop', tier: 'free' })).body.store
    const visitorId = randomUUID()
    const res = await login(tenantId, 'User03', { visitorId })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 1800, user: { username: 'user03', role: 'customer' } })
    expect(await verifyRetailerToken(res.body.accessToken, keys.publicKey)).toMatchObject({ sub: res.body.user.id, tid: tenantId, role: 'customer' })
    // Basketline knows the customer by the store's ID for them, and keeps the visitor's UUID.
    expect(res.body.basketline).toEqual({ shopperToken: `shopper-for-${res.body.user.id}`, expiresIn: 1800, userId: visitorId })
    const asked = calls.findLast((c) => c.path === '/auth/shopper-token')!
    expect(asked.headers.get('authorization')).toBe(`ApiKey bl_sk_key-of-${tenantId}`)
    expect(asked.body).toEqual({ customerId: res.body.user.id, visitorId, clientType: 'web' })

    // The SDK renews it with the store's token.
    const renewed = await request(app).post('/api/v1/auth/shopper-token').set('Authorization', `Bearer ${res.body.accessToken}`).send({})
    expect(renewed.status).toBe(201)
    expect(renewed.body.shopperToken).toBe(`shopper-for-${res.body.user.id}`)
  })

  it('gives the staff no shopper token, and staff tokens get none', async () => {
    const { tenantId } = (await connect({ name: 'Staffed', tier: 'free' })).body.store
    const staff = await login(tenantId, 'staff')
    expect(staff.body).toMatchObject({ user: { role: 'staff' }, basketline: null })
    expect((await request(app).post('/api/v1/auth/shopper-token').set('Authorization', `Bearer ${staff.body.accessToken}`).send({})).status).toBe(403)
  })

  it("signs a customer in even when Basketline is down (their events count as a visitor's)", async () => {
    const { tenantId } = (await connect({ name: 'Resilient', tier: 'free' })).body.store
    basketlineDown = true
    try {
      const res = await login(tenantId, 'user01')
      expect(res.status).toBe(200)
      expect(res.body.basketline).toBeNull()
      const renew = await request(app).post('/api/v1/auth/shopper-token').set('Authorization', `Bearer ${res.body.accessToken}`).send({})
      expect(renew.status).toBe(503)
    } finally {
      basketlineDown = false
    }
  })

  it("rejects wrong passwords, other stores' users and unknown stores alike", async () => {
    const { tenantId } = (await connect({ name: 'Careful', tier: 'free' })).body.store
    const other = (await connect({ name: 'Other', tier: 'free' })).body.store.tenantId
    const wrong = await login(tenantId, 'user01', { password: 'nope' })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS')
    expect((await login(tenantId, 'nobody')).status).toBe(401)
    // Logins are per store: the other store's user01 is another person.
    const ours = await login(tenantId, 'user01')
    const theirs = await login(other, 'user01')
    expect(ours.body.user.id).not.toBe(theirs.body.user.id)
    expect((await login(randomUUID(), 'user01')).body.error.code).toBe('STORE_NOT_FOUND')
    expect((await request(app).post('/api/v1/auth/login').send({ username: 'user01', password: 'test' })).body.error.code).toBe('TENANT_REQUIRED')
    expect((await request(app).post('/api/v1/auth/shopper-token').send({})).status).toBe(401)
  })
})
