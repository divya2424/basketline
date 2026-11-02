import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeJwt } from 'jose'
import { randomUUID } from 'node:crypto'
import { closeDb, createLogger, createMemoryEventBus, verifyEventToken, verifyIntegrationToken, verifyVisitorToken, type MemoryEventBus } from '@basketline/platform'
import { createTestDatabase, createTestKeys, tokenFor, type TestKeys } from '@basketline/platform/testing'
import { buildAuthApp } from '../src/app.ts'
import { createAuthDb, migrateAuthDb, withTenant, type Db } from '../src/db/client.ts'
import { insertAccount } from '../src/repositories/account.repository.ts'
import { createShopperService } from '../src/services/shopper.service.ts'
import { changeRole, createUser, disableUser } from '../src/services/user-admin.service.ts'

const logger = createLogger('auth-test')
let testDb: Awaited<ReturnType<typeof createTestDatabase>>
let db: Db
let keys: TestKeys
let app: ReturnType<typeof buildAuthApp>
let bus: MemoryEventBus

const PASSWORD = 'correct horse battery'
const TENANT = randomUUID()
// A second account, for checks across tenants.
const OTHER_TENANT = randomUUID()

beforeAll(async () => {
  testDb = await createTestDatabase()
  db = createAuthDb(testDb.url)
  await migrateAuthDb(db)
  await insertAccount(db, { tenantId: TENANT, name: 'Test storefront', tier: 'free' })
  await insertAccount(db, { tenantId: OTHER_TENANT, name: 'Other storefront', tier: 'pro' })
  keys = await createTestKeys()
  bus = createMemoryEventBus(logger)
  app = buildAuthApp({ db, bus, logger, privateKey: keys.privateKey, publicKey: keys.publicKey, loginRateLimit: 5 })
})

afterAll(async () => {
  await closeDb(db)
  await testDb.drop()
})

let counter = 0
const uniqueName = () => `user${Date.now().toString(36)}${counter++}`

/** A user, as an operator creates one (the auth CLI): there's no self-registration. A campaign manager. */
async function addUser(username = uniqueName(), tenant: string = TENANT, password = PASSWORD) {
  const { user } = await withTenant(db, tenant, (tx) => createUser(tx, { username, password, role: 'campaign-manager', tenantId: tenant }, null))
  return { username, user: { id: user.id, role: user.role, tenantId: user.tenantId } }
}

const login = (username: string, clientType = 'web', password = PASSWORD, tenant = TENANT) =>
  request(app).post('/api/v1/auth/login').set('tenant_id', tenant).send({ username, password, clientType })

/**
 * Runs SQL the way the service does: in a transaction that sees one tenant's
 * users and user_login rows (row-level security hides the rest, and all of
 * them when no tenant is set).
 */
async function queryAsTenant(text: string, params: unknown[] = [], tenant: string = TENANT) {
  const client = await db.$client.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant])
    const result = await client.query(text, params)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** Events the app published to the (in-memory) Kafka bus. */
function publishedEvents(type?: string) {
  return bus.published
    .map((message) => message.envelope as { eventType: string; payload: Record<string, unknown> })
    .filter((envelope) => !type || envelope.eventType === type)
}

describe('users', () => {
  it('stores an Argon2id hash, never the password; nobody can sign themselves up', async () => {
    const { user } = await addUser()
    const { rows } = await queryAsTenant('SELECT password_hash FROM users WHERE id = $1', [user.id])
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/)
    expect(rows[0].password_hash).not.toContain(PASSWORD)
    // Shoppers belong to the retailer: Basketline has no registration.
    const signUp = await request(app).post('/api/v1/auth/register').set('tenant_id', TENANT).send({ username: uniqueName(), password: PASSWORD })
    expect(signUp.status).toBe(404)
  })

  it('rejects duplicate usernames case-insensitively', async () => {
    const { username } = await addUser()
    await expect(addUser(username.toUpperCase())).rejects.toMatchObject({ code: 'USERNAME_TAKEN' })
  })

  it('keeps usernames per tenant: the same name signs in separately in each', async () => {
    const { username, user } = await addUser()
    const theirs = await addUser(username, OTHER_TENANT, 'another long password')
    expect((await login(username, 'web', PASSWORD, OTHER_TENANT)).status).toBe(401)
    expect((await login(username, 'web', 'another long password', OTHER_TENANT)).body.user).toMatchObject({ id: theirs.user.id, tenantId: OTHER_TENANT })
    expect((await login(username)).body.user.id).toBe(user.id)
    expect((await request(app).post('/api/v1/auth/login').send({ username, password: PASSWORD, clientType: 'web' })).body.error.code).toBe('TENANT_REQUIRED')
  })

  it('requires the tenant as a UUID, and one that has an account', async () => {
    for (const tenant of ['', 'tenant_ecommerce']) {
      const res = await request(app).post('/api/v1/auth/visitor').set('tenant_id', tenant)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('TENANT_REQUIRED')
    }
    const visitor = await request(app).post('/api/v1/auth/visitor').set('tenant_id', randomUUID())
    expect(visitor.status).toBe(404)
    expect(visitor.body.error.code).toBe('TENANT_NOT_FOUND')
  })
})

describe('tenant isolation (row-level security)', () => {
  it('shows users and user_login rows only to their own tenant, and none without a tenant', async () => {
    const { username, user } = await addUser()
    await login(username)
    const count = async (table: string, tenant?: string) => {
      const text = `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'} = $1`
      const result = tenant ? await queryAsTenant(text, [user.id], tenant) : await db.$client.query(text, [user.id])
      return result.rows[0].n as number
    }
    for (const table of ['users', 'user_login']) {
      expect(await count(table), `${table} without a tenant`).toBe(0)
      expect(await count(table, OTHER_TENANT), `${table} as another tenant`).toBe(0)
      expect(await count(table, TENANT), `${table} as its tenant`).toBe(1)
    }
  })

  it("rejects writing a row into another tenant from inside a tenant's transaction", async () => {
    const insert = queryAsTenant(
      "INSERT INTO users (id, username, password_hash, role, tenant_id) VALUES ($1, 'intruder', 'x', 'campaign-manager', $2)",
      [randomUUID(), OTHER_TENANT],
      TENANT,
    )
    await expect(insert).rejects.toThrow(/row-level security/)
  })

  it("rejects a token whose tenant isn't the user's", async () => {
    const { username } = await addUser()
    const { body } = await login(username)
    const crossTenant = await tokenFor(keys, 'campaign-manager', { sub: body.user.id, sid: body.session.id, tid: OTHER_TENANT })
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', crossTenant.header)
    expect(me.status).toBe(401)
  })
})

describe('visitor tokens', () => {
  it("issues an events-only token bound to the storefront's tenant", async () => {
    const res = await request(app).post('/api/v1/auth/visitor').set('tenant_id', TENANT)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 1800 })
    expect(await verifyVisitorToken(res.body.visitorToken, keys.publicKey)).toMatchObject({ tid: TENANT })
    // Not an access token: the other APIs reject it.
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.visitorToken}`)
    expect(me.status).toBe(401)
    expect((await request(app).post('/api/v1/auth/visitor')).body.error.code).toBe('TENANT_REQUIRED')
  })

  it("keeps the client's userId across tokens, and a random one without it", async () => {
    const userId = randomUUID()
    const visitor = (body?: object) => request(app).post('/api/v1/auth/visitor').set('tenant_id', TENANT).send(body)
    const visitorId = async (body?: object) => (await verifyVisitorToken((await visitor(body)).body.visitorToken, keys.publicKey)).sub
    expect(await visitorId({ userId })).toBe(userId)
    expect(await visitorId({ userId })).toBe(userId)
    expect((await visitor({ userId })).body.userId).toBe(userId)
    expect(await visitorId()).not.toBe(userId)

    const invalid = await visitor({ userId: 'not-a-uuid' })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('vendor API keys and shopper tokens', () => {
  const shopperToken = (key: string | undefined, body: object, tenant: string = TENANT) => {
    const req = request(app).post('/api/v1/auth/shopper-token').set('tenant_id', tenant)
    return (key ? req.set('Authorization', `ApiKey ${key}`) : req).send(body)
  }

  it("issues a registered, events-only token for the vendor's customer, the same person every time", async () => {
    const shoppers = createShopperService({ db, privateKey: keys.privateKey })
    const { key, prefix } = await shoppers.createApiKey(TENANT, 'Production web')
    expect(key).toMatch(/^bl_sk_[A-Za-z0-9_-]{43}$/)
    expect(key.startsWith(prefix)).toBe(true)
    // Only the hash is stored.
    expect((await queryAsTenant('SELECT key_hash FROM api_keys WHERE prefix = $1', [prefix])).rows[0].key_hash).not.toContain(key)

    const visitor = randomUUID()
    const first = await shopperToken(key, { customerId: 'cust-42', visitorId: visitor })
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 1800, userId: visitor })
    // Accepted as a registered sender, for this tenant, by event ingestion only.
    expect(await verifyEventToken(first.body.shopperToken, keys.publicKey)).toMatchObject({ tenantId: TENANT, userId: visitor, userType: 'registered', clientType: 'web' })
    expect(decodeJwt(first.body.shopperToken).aud).toBe('basketline-events')

    // Later: the same UUID, whatever visitor ID comes with it.
    const again = await shopperToken(key, { customerId: 'cust-42', visitorId: randomUUID(), clientType: 'mobile' })
    expect(again.body.userId).toBe(visitor)
    // Another customer can't take a UUID already in use: it gets its own.
    const other = await shopperToken(key, { customerId: 'cust-43', visitorId: visitor })
    expect(other.body.userId).not.toBe(visitor)
  })

  it('rejects a missing, unknown, revoked or other tenant\'s key', async () => {
    const shoppers = createShopperService({ db, privateKey: keys.privateKey })
    const { key, prefix } = await shoppers.createApiKey(TENANT, 'To revoke')
    const others = await shoppers.createApiKey(OTHER_TENANT, 'Other store')
    for (const res of [
      await shopperToken(undefined, { customerId: 'c' }),
      await shopperToken('bl_sk_not-a-real-key', { customerId: 'c' }),
      await shopperToken(others.key, { customerId: 'c' }),
    ]) {
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_API_KEY')
    }
    expect((await shopperToken(key, { customerId: 'c' })).status).toBe(201)
    expect(await shoppers.revokeApiKey(TENANT, prefix)).toBe(1)
    expect((await shopperToken(key, { customerId: 'c' })).status).toBe(401)
    expect((await shopperToken(others.key, { customerId: '' }, OTHER_TENANT)).status).toBe(400)
  })
})

describe('login', () => {
  it('returns the documented response, a 30-minute JWT and a new session row', async () => {
    const { username, user } = await addUser()
    const res = await login(username, 'mobile')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 1800, user: { id: user.id, username, role: 'campaign-manager', tenantId: TENANT } })
    expect(res.body.session).toMatchObject({ clientType: 'mobile', sessionEndTime: null })

    const claims = decodeJwt(res.body.accessToken)
    expect(Object.keys(claims)).toEqual(expect.arrayContaining(['sub', 'sid', 'role', 'tid', 'iat', 'exp']))
    expect(claims.exp! - claims.iat!).toBe(1800)
    expect(claims).toMatchObject({ sub: user.id, sid: res.body.session.id, role: 'campaign-manager', tid: TENANT, client: 'mobile' })
    expect(new Date(res.body.session.expiresAt).getTime()).toBe(claims.exp! * 1000)

    const { rows } = await queryAsTenant('SELECT tenant_id, client_type, session_end_time FROM user_login WHERE id = $1', [res.body.session.id])
    expect(rows[0]).toEqual({ tenant_id: TENANT, client_type: 'mobile', session_end_time: null })
    const { rows: u } = await queryAsTenant('SELECT last_login_at FROM users WHERE id = $1', [user.id])
    expect(u[0].last_login_at).not.toBeNull()
  })

  it('creates separate sessions for web and mobile logins', async () => {
    const { username } = await addUser()
    const web = await login(username, 'web')
    const mobile = await login(username, 'mobile')
    expect(web.body.session.id).not.toBe(mobile.body.session.id)
    const sessions = await request(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${mobile.body.accessToken}`)
    expect(sessions.body.items.map((s: { clientType: string }) => s.clientType)).toEqual(['mobile', 'web'])
    expect(sessions.body.items[0]).toMatchObject({ current: true, status: 'active' })
    expect(sessions.body.page.total).toBe(2)
  })

  it('rejects wrong passwords and unknown users with the same error, and never echoes the password', async () => {
    const { username } = await addUser()
    const wrong = await login(username, 'web', 'wrong password!!')
    const unknown = await login('nobody-here', 'web')
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
      expect(JSON.stringify(res.body)).not.toContain('wrong password')
    }
  })

  it('rate limits repeated attempts for the same username', async () => {
    const { username } = await addUser()
    const statuses: number[] = []
    for (let i = 0; i < 7; i += 1) statuses.push((await login(username, 'web', 'not the password')).status)
    expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })

  it('rejects disabled accounts', async () => {
    const { username } = await addUser()
    await withTenant(db, TENANT, (tx) => disableUser(tx, TENANT, username, null))
    const res = await login(username)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED')
  })
})

describe('logout and session state', () => {
  it('records the actual logout time, emits SessionRevoked and rejects the token afterwards', async () => {
    const { username } = await addUser()
    const { body } = await login(username)
    const auth = `Bearer ${body.accessToken}`
    const before = Date.now()
    const res = await request(app).post('/api/v1/auth/logout').set('Authorization', auth)
    expect(res.status).toBe(200)
    const endedAt = new Date(res.body.session.sessionEndTime).getTime()
    expect(endedAt).toBeGreaterThanOrEqual(before - 1000)
    expect(endedAt).toBeLessThanOrEqual(Date.now() + 1000)

    const revoked = publishedEvents('SessionRevoked').find((event) => event.payload.sessionId === body.session.id)
    expect(revoked?.payload).toMatchObject({ userId: body.user.id })

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', auth)
    expect(me.status).toBe(401)
    expect(me.body.error.code).toBe('SESSION_REVOKED')
  })

  it('returns the current user from /me', async () => {
    const { username, user } = await addUser()
    const { body } = await login(username)
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${body.accessToken}`)
    expect(me.status).toBe(200)
    expect(me.body.user).toMatchObject({ id: user.id, username, role: 'campaign-manager', isActive: true })
    expect(JSON.stringify(me.body)).not.toMatch(/password|argon2/)
  })

  it('rejects expired, foreign-signed and missing tokens', async () => {
    const { username } = await addUser()
    const { body } = await login(username)
    const expired = await tokenFor(keys, 'campaign-manager', { sub: body.user.id, sid: body.session.id, issuedAt: new Date(Date.now() - 31 * 60_000) })
    const foreign = await tokenFor(await createTestKeys(), 'campaign-manager', { sub: body.user.id, sid: body.session.id })
    for (const header of [expired.header, foreign.header]) {
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', header)
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_TOKEN')
    }
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401)
  })

  it("never changes a seller-manager's role (its seller would be left over), and a same-role change is a no-op", async () => {
    const { username } = await addUser()
    const same = await withTenant(db, TENANT, (tx) => changeRole(tx, TENANT, username, 'campaign-manager', null))
    expect(same.events).toEqual([])
    await expect(withTenant(db, TENANT, (tx) => changeRole(tx, TENANT, username, 'seller-manager', null))).rejects.toMatchObject({ code: 'SELLER_REQUIRED' })
  })

  it('disabling a user ends their open sessions and emits SessionRevoked for each', async () => {
    const { username } = await addUser()
    const a = await login(username, 'web')
    const b = await login(username, 'mobile')
    const { events } = await withTenant(db, TENANT, (tx) => disableUser(tx, TENANT, username, null))
    expect(events[0]?.eventType).toBe('UserDisabled')
    const revokedIds = events.filter((e) => e.eventType === 'SessionRevoked').map((e) => (e.payload as { sessionId: string }).sessionId)
    expect(revokedIds).toEqual(expect.arrayContaining([a.body.session.id, b.body.session.id]))
    const { rows } = await queryAsTenant('SELECT count(*)::int AS open FROM user_login WHERE user_id = $1 AND session_end_time IS NULL', [a.body.user.id])
    expect(rows[0].open).toBe(0)
  })
})

describe('event publishing (after commit, no outbox)', () => {
  it('publishes UserCreated to auth.user.v1, keyed by user ID', async () => {
    const res = await request(app).post('/api/v1/accounts').send({ name: 'Published', tier: 'free' })
    const user = (await request(app).post('/api/v1/auth/login').set('tenant_id', res.body.account.tenantId).send({ username: 'onboarding', password: 'test', clientType: 'web' })).body.user
    const message = bus.published.find((m) => m.envelope.eventType === 'UserCreated' && m.key === user.id)
    expect(message).toMatchObject({ topic: 'auth.user.v1', envelope: { producer: 'auth-service', aggregateVersion: 1, eventVersion: 1 } })
  })

  it('publishes nothing when the transaction rolls back', async () => {
    const before = bus.published.length
    // The onboarding user is created, then the second user fails: the tenant's whole onboarding rolls back.
    const res = await request(app).post('/api/v1/accounts').send({ name: 'Rolled back', tier: 'free', sellerManagers: [{ username: 'onboarding', sellerId: randomUUID() }] })
    expect(res.status).toBe(409)
    expect(bus.published.length).toBe(before)
    expect((await request(app).get('/api/v1/accounts')).body.items.map((a: { name: string }) => a.name)).not.toContain('Rolled back')
  })

  it('still succeeds when Kafka is unavailable (the event is logged and dropped)', async () => {
    const failing = createMemoryEventBus(logger)
    failing.publish = async () => {
      throw new Error('broker down')
    }
    const failingApp = buildAuthApp({ db, bus: failing, logger, privateKey: keys.privateKey, publicKey: keys.publicKey })
    const res = await request(failingApp).post('/api/v1/accounts').send({ name: 'Kafka down', tier: 'free' })
    expect(res.status).toBe(201)
    const { rows } = await queryAsTenant('SELECT count(*)::int AS n FROM users', [], res.body.account.tenantId)
    expect(rows[0].n).toBe(1)
  })
})

describe('tenant onboarding (/accounts)', () => {
  const onboard = (body: object) => request(app).post('/api/v1/accounts').send(body)
  const signIn = (tenant: string, username: string) =>
    request(app).post('/api/v1/auth/login').set('tenant_id', tenant).send({ username, password: 'test', clientType: 'web' })

  it('creates the account with a generated tenant ID and an onboarding campaign manager', async () => {
    const res = await onboard({ name: '  Acme Store ', tier: 'pro' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ account: { name: 'Acme Store', tier: 'pro' }, users: [{ username: 'onboarding', role: 'campaign-manager' }], password: 'test' })
    const tenant = res.body.account.tenantId as string
    expect(tenant).toMatch(/^[0-9a-f-]{36}$/)
    const login = await signIn(tenant, 'onboarding')
    expect(login.status).toBe(200)
    expect(login.body.user).toMatchObject({ role: 'campaign-manager', tenantId: tenant })
    const created = bus.published.filter((m) => m.envelope.eventType === 'UserCreated' && m.key === login.body.user.id)
    expect(created).toHaveLength(1)
  })

  it("gives the vendor a first API key, shown once, that its managers can list, add to and revoke", async () => {
    const res = await onboard({ name: 'Vendor with a key', tier: 'free', sellerManagers: [{ username: 'seller01', sellerId: randomUUID() }] })
    const tenant = res.body.account.tenantId as string
    const first = res.body.apiKey as { key: string; prefix: string; name: string }
    expect(first).toMatchObject({ name: 'Default', key: expect.stringMatching(/^bl_sk_/) })
    // It works at once: the vendor's backend can get shopper tokens with it.
    const token = await request(app).post('/api/v1/auth/shopper-token').set('tenant_id', tenant).set('Authorization', `ApiKey ${first.key}`).send({ customerId: 'c-1' })
    expect(token.status).toBe(201)

    const manager = `Bearer ${(await signIn(tenant, 'onboarding')).body.accessToken}`
    const sellerManager = `Bearer ${(await signIn(tenant, 'seller01')).body.accessToken}`
    const keys = () => request(app).get('/api/v1/auth/api-keys').set('Authorization', manager)
    // Listed by prefix, never the key itself.
    expect((await keys()).body.items).toEqual([{ prefix: first.prefix, name: 'Default', createdAt: expect.any(String), revokedAt: null }])
    expect(JSON.stringify((await keys()).body)).not.toContain(first.key)

    const added = await request(app).post('/api/v1/auth/api-keys').set('Authorization', manager).send({ name: 'Mobile app' })
    expect(added.status).toBe(201)
    expect(added.body).toMatchObject({ name: 'Mobile app', key: expect.stringMatching(/^bl_sk_/) })
    expect((await request(app).delete(`/api/v1/auth/api-keys/${first.prefix}`).set('Authorization', manager)).status).toBe(204)
    expect((await request(app).delete(`/api/v1/auth/api-keys/${first.prefix}`).set('Authorization', manager)).status).toBe(404)
    const revoked = await request(app).post('/api/v1/auth/shopper-token').set('tenant_id', tenant).set('Authorization', `ApiKey ${first.key}`).send({ customerId: 'c-1' })
    expect(revoked.status).toBe(401)
    expect((await keys()).body.items.map((k: { name: string; revokedAt: string | null }) => [k.name, k.revokedAt === null])).toEqual([
      ['Mobile app', true],
      ['Default', false],
    ])

    // Not for seller managers, and a manager sees only their own tenant's keys.
    expect((await request(app).get('/api/v1/auth/api-keys').set('Authorization', sellerManager)).status).toBe(403)
    const other = await onboard({ name: 'Another vendor', tier: 'free' })
    const otherManager = `Bearer ${(await signIn(other.body.account.tenantId, 'onboarding')).body.accessToken}`
    const otherKeys = await request(app).get('/api/v1/auth/api-keys').set('Authorization', otherManager)
    expect(otherKeys.body.items.map((k: { prefix: string }) => k.prefix)).toEqual([other.body.apiKey.prefix])
    expect((await request(app).delete(`/api/v1/auth/api-keys/${added.body.prefix}`).set('Authorization', otherManager)).status).toBe(404)
  })

  it("lets the tenant's managers set its allowed websites, normalized, and tells the gateway", async () => {
    const res = await onboard({ name: 'Vendor with a website', tier: 'free', sellerManagers: [{ username: 'seller01', sellerId: randomUUID() }] })
    const tenant = res.body.account.tenantId as string
    const manager = `Bearer ${(await signIn(tenant, 'onboarding')).body.accessToken}`
    const sellerManager = `Bearer ${(await signIn(tenant, 'seller01')).body.accessToken}`
    const origins = () => request(app).get('/api/v1/auth/allowed-origins').set('Authorization', manager)
    const set = (body: object, auth = manager) => request(app).put('/api/v1/auth/allowed-origins').set('Authorization', auth).send(body)
    // None at first: any website may send the tenant's events.
    expect((await origins()).body).toEqual({ origins: [] })

    const saved = await set({ origins: ['HTTPS://Shop.Example:443/', 'https://shop.example', 'http://localhost:3000'] })
    expect(saved.status).toBe(200)
    expect(saved.body).toEqual({ origins: ['https://shop.example', 'http://localhost:3000'] })
    expect((await origins()).body.origins).toEqual(['https://shop.example', 'http://localhost:3000'])
    const changed = publishedEvents('TenantOriginsChanged').filter((event) => event.payload.tenantId === tenant)
    expect(changed.at(-1)!.payload).toMatchObject({ origins: ['https://shop.example', 'http://localhost:3000'], version: 1 })
    expect((await set({ origins: [] })).body.origins).toEqual([])
    expect(publishedEvents('TenantOriginsChanged').filter((event) => event.payload.tenantId === tenant).at(-1)!.payload).toMatchObject({ origins: [], version: 2 })

    const bad = await set({ origins: ['https://shop.example/checkout', 'ftp://shop.example', 'https://*.shop.example', 'shop.example'] })
    expect(bad.status).toBe(400)
    expect(bad.body.error.details.errors).toHaveLength(4)
    expect((await set({ origins: Array.from({ length: 21 }, (_, i) => `https://shop${i}.example`) })).status).toBe(400)
    expect((await set({ origins: [] }, sellerManager)).status).toBe(403)
  })

  it('deletes a tenant and all of its identity data when its name is typed again, then tells the other services', async () => {
    const res = await onboard({ name: 'To Delete', tier: 'free', sellerManagers: [{ username: 'seller01', sellerId: randomUUID() }] })
    const tenant = res.body.account.tenantId as string
    const kept = await onboard({ name: 'To Keep', tier: 'free' })
    expect((await signIn(tenant, 'onboarding')).status).toBe(200)
    await request(app).post('/api/v1/auth/shopper-token').set('tenant_id', tenant).set('Authorization', `ApiKey ${res.body.apiKey.key}`).send({ customerId: 'c-1' })
    const remove = (body: object, id = tenant) => request(app).delete(`/api/v1/accounts/${id}`).send(body)

    // The name must match exactly (spaces around it aside).
    expect((await remove({ confirmName: 'to delete' })).body.error.code).toBe('CONFIRMATION_MISMATCH')
    expect((await remove({})).status).toBe(400)
    expect((await remove({ confirmName: 'x' }, 'not-a-uuid')).status).toBe(400)
    expect((await remove({ confirmName: 'x' }, randomUUID())).status).toBe(404)

    const before = bus.published.length
    const deleted = await remove({ confirmName: ' To Delete ' })
    expect(deleted.status).toBe(200)
    expect(deleted.body.deleted).toMatchObject({ tenantId: tenant, name: 'To Delete' })
    for (const table of ['users', 'user_login', 'api_keys', 'external_customers']) {
      expect((await queryAsTenant(`SELECT count(*)::int AS n FROM ${table}`, [], tenant)).rows[0].n, table).toBe(0)
    }
    expect((await request(app).get('/api/v1/accounts')).body.items.map((a: { tenantId: string }) => a.tenantId)).not.toContain(tenant)
    expect((await signIn(tenant, 'onboarding')).status).toBe(401)
    const event = bus.published.slice(before).find((m) => m.envelope.eventType === 'TenantDeleted')!
    expect(event).toMatchObject({ topic: 'auth.tenant.v1', key: tenant, envelope: { payload: { tenantId: tenant, name: 'To Delete' } } })
    // Other tenants are untouched.
    expect((await signIn(kept.body.account.tenantId, 'onboarding')).status).toBe(200)
  })

  it('adds the seller managers the retailer names, for its sellers, all signing in with "test"', async () => {
    const [north, south] = [randomUUID(), randomUUID()]
    const res = await onboard({ name: 'With sellers', tier: 'free', sellerManagers: [{ username: 'seller01', sellerId: north }, { username: 'seller02', sellerId: south.toUpperCase() }] })
    expect(res.status).toBe(201)
    const tenant = res.body.account.tenantId as string
    expect(res.body.users).toEqual([
      { username: 'onboarding', role: 'campaign-manager' },
      { username: 'seller01', role: 'seller-manager' },
      { username: 'seller02', role: 'seller-manager' },
    ])
    // Each token carries its seller.
    const seller = await signIn(tenant, 'seller02')
    expect(seller.body.user).toMatchObject({ role: 'seller-manager', sellerId: south })
    expect(decodeJwt(seller.body.accessToken)).toMatchObject({ role: 'seller-manager', sel: south })
    // The users belong to the new tenant only.
    expect((await signIn(TENANT, 'seller01')).status).toBe(401)
    const { rows } = await queryAsTenant('SELECT count(*)::int AS n FROM users', [], tenant)
    expect(rows[0].n).toBe(3)
  })

  it('creates a seller-manager only with its seller, and no other role with one', async () => {
    await expect(withTenant(db, TENANT, (tx) => createUser(tx, { username: 'no-seller', password: 'x', role: 'seller-manager', tenantId: TENANT }, null))).rejects.toMatchObject({ code: 'SELLER_REQUIRED' })
    await expect(withTenant(db, TENANT, (tx) => createUser(tx, { username: 'odd', password: 'x', role: 'campaign-manager', tenantId: TENANT, sellerId: randomUUID() }, null))).rejects.toMatchObject({ code: 'SELLER_REQUIRED' })
  })

  it("exchanges the tenant's API key for an integration token, with no internal shortcut", async () => {
    const res = await onboard({ name: 'Integrated', tier: 'free' })
    const tenant = res.body.account.tenantId as string
    const exchange = (key: string) => request(app).post('/api/v1/auth/integration-token').set('tenant_id', tenant).set('Authorization', `ApiKey ${key}`)
    const ok = await exchange(res.body.apiKey.key)
    expect(ok.status).toBe(201)
    expect(await verifyIntegrationToken(ok.body.integrationToken, keys.publicKey)).toMatchObject({ tid: tenant })
    // Not an access token or an events token: only the reference API accepts it.
    expect(decodeJwt(ok.body.integrationToken).aud).toBe('basketline-integration')
    expect((await exchange('bl_sk_wrong')).status).toBe(401)

    // The simulated retailer's old internal endpoint is gone: every retailer uses its API key.
    expect((await request(app).post('/internal/integration-token').send({ tenantId: tenant })).status).toBe(404)
  })

  it('publishes TenantOnboarded with the tier, for the ingestion budget; seeding is the retailer\'s', async () => {
    const res = await onboard({ name: 'Onboarded', tier: 'pro' })
    const tenant = res.body.account.tenantId as string
    const message = bus.published.find((m) => m.envelope.eventType === 'TenantOnboarded' && m.key === tenant)!
    expect(message.topic).toBe('auth.tenant.v1')
    expect(message.envelope.payload).toEqual({ tenantId: tenant, name: 'Onboarded', tier: 'pro' })
    expect(res.body).not.toHaveProperty('seed')
  })

  it('lists the onboarded accounts, newest first', async () => {
    const { body } = await onboard({ name: 'Newest', tier: 'enterprise' })
    const list = await request(app).get('/api/v1/accounts')
    expect(list.status).toBe(200)
    expect(list.body.items[0]).toEqual({ tenantId: body.account.tenantId, name: 'Newest', tier: 'enterprise', createdAt: body.account.createdAt })
    expect(list.body.items.map((a: { tenantId: string }) => a.tenantId)).toEqual(expect.arrayContaining([TENANT, OTHER_TENANT]))
  })

  it('validates the request, and never takes a tenant ID from the client', async () => {
    for (const body of [
      { name: '', tier: 'free' },
      { name: 'x', tier: 'gold' },
      { name: 'x', tier: 'free', dummyUsers: true },
      { name: 'x', tier: 'free', sellerManagers: [{ username: 'seller01', sellerId: 'not-a-uuid' }] },
      { name: 'x', tier: 'free', sellerManagers: 'seller01' },
      { name: 'x', tier: 'free', tenantId: randomUUID() },
    ]) {
      const res = await onboard(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
  })
})
