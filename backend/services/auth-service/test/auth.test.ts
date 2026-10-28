import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeJwt } from 'jose'
import { randomUUID } from 'node:crypto'
import { closeDb, createLogger, createMemoryEventBus, verifyVisitorToken, type MemoryEventBus } from '@shopsphere/platform'
import { createTestDatabase, createTestKeys, tokenFor, type TestKeys } from '@shopsphere/platform/testing'
import { buildAuthApp } from '../src/app.ts'
import { createAuthDb, migrateAuthDb, withTenant, type Db } from '../src/db/client.ts'
import { insertAccount } from '../src/repositories/account.repository.ts'
import { seedPlan } from '../src/services/account.service.ts'
import { changeRole, disableUser } from '../src/services/user-admin.service.ts'

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

/** POST /register from the storefront of `tenant` (its tenant_id header). */
const registerRequest = (body: object, tenant: string = TENANT, target = app) =>
  request(target).post('/api/v1/auth/register').set('tenant_id', tenant).send(body)

async function register(username = uniqueName()) {
  const res = await registerRequest({ username, password: PASSWORD })
  expect(res.status).toBe(201)
  return { username, user: res.body.user as { id: string; role: string; tenantId: string } }
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

describe('registration', () => {
  it('creates a standard user, hashes the password with Argon2id and emits UserCreated', async () => {
    const { username, user } = await register()
    expect(user).toMatchObject({ role: 'standard-user', tenantId: TENANT })
    const { rows } = await queryAsTenant('SELECT password_hash FROM users WHERE id = $1', [user.id])
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/)
    expect(rows[0].password_hash).not.toContain(PASSWORD)
    const created = publishedEvents('UserCreated').find((event) => event.payload.userId === user.id)
    expect(created?.payload).toMatchObject({ username, role: 'standard-user', isActive: true })
  })

  it('rejects attempts to self-assign a role', async () => {
    const res = await registerRequest({ username: uniqueName(), password: PASSWORD, role: 'campaign-manager' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects duplicate usernames case-insensitively and weak passwords', async () => {
    const { username } = await register()
    const dup = await registerRequest({ username: username.toUpperCase(), password: PASSWORD })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('USERNAME_TAKEN')
    const weak = await registerRequest({ username: uniqueName(), password: 'short' })
    expect(weak.status).toBe(400)
  })

  it('keeps usernames per tenant: the same name can sign up and sign in separately in each', async () => {
    const { username, user } = await register()
    const other = OTHER_TENANT
    const theirs = await registerRequest({ username, password: 'another long password' }, other)
    expect(theirs.status).toBe(201)
    expect((await login(username, 'web', PASSWORD, other)).status).toBe(401)
    expect((await login(username, 'web', 'another long password', other)).body.user).toMatchObject({ id: theirs.body.user.id, tenantId: other })
    expect((await login(username)).body.user.id).toBe(user.id)
    expect((await request(app).post('/api/v1/auth/login').send({ username, password: PASSWORD, clientType: 'web' })).body.error.code).toBe('TENANT_REQUIRED')
  })

  it('requires the storefront tenant as a UUID', async () => {
    for (const tenant of ['', 'tenant_shopsphere']) {
      const res = await registerRequest({ username: uniqueName(), password: PASSWORD }, tenant)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('TENANT_REQUIRED')
    }
  })

  it('rejects tenants that have no account', async () => {
    const unknown = randomUUID()
    const res = await registerRequest({ username: uniqueName(), password: PASSWORD }, unknown)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('TENANT_NOT_FOUND')
    const visitor = await request(app).post('/api/v1/auth/visitor').set('tenant_id', unknown)
    expect(visitor.status).toBe(404)
    expect(visitor.body.error.code).toBe('TENANT_NOT_FOUND')
  })
})

describe('tenant isolation (row-level security)', () => {
  it('shows users and user_login rows only to their own tenant, and none without a tenant', async () => {
    const { username, user } = await register()
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
      "INSERT INTO users (id, username, password_hash, tenant_id) VALUES ($1, 'intruder', 'x', $2)",
      [randomUUID(), OTHER_TENANT],
      TENANT,
    )
    await expect(insert).rejects.toThrow(/row-level security/)
  })

  it("rejects a token whose tenant isn't the user's", async () => {
    const { username } = await register()
    const { body } = await login(username)
    const crossTenant = await tokenFor(keys, 'standard-user', { sub: body.user.id, sid: body.session.id, tid: OTHER_TENANT })
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
})

describe('login', () => {
  it('returns the documented response, a 30-minute JWT and a new session row', async () => {
    const { username, user } = await register()
    const res = await login(username, 'mobile')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 1800, user: { id: user.id, username, role: 'standard-user', tenantId: TENANT } })
    expect(res.body.session).toMatchObject({ clientType: 'mobile', sessionEndTime: null })

    const claims = decodeJwt(res.body.accessToken)
    expect(Object.keys(claims)).toEqual(expect.arrayContaining(['sub', 'sid', 'role', 'tid', 'iat', 'exp']))
    expect(claims.exp! - claims.iat!).toBe(1800)
    expect(claims).toMatchObject({ sub: user.id, sid: res.body.session.id, role: 'standard-user', tid: TENANT })
    expect(new Date(res.body.session.expiresAt).getTime()).toBe(claims.exp! * 1000)

    const { rows } = await queryAsTenant('SELECT tenant_id, client_type, session_end_time FROM user_login WHERE id = $1', [res.body.session.id])
    expect(rows[0]).toEqual({ tenant_id: TENANT, client_type: 'mobile', session_end_time: null })
    const { rows: u } = await queryAsTenant('SELECT last_login_at FROM users WHERE id = $1', [user.id])
    expect(u[0].last_login_at).not.toBeNull()
  })

  it('creates separate sessions for web and mobile logins', async () => {
    const { username } = await register()
    const web = await login(username, 'web')
    const mobile = await login(username, 'mobile')
    expect(web.body.session.id).not.toBe(mobile.body.session.id)
    const sessions = await request(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${mobile.body.accessToken}`)
    expect(sessions.body.items.map((s: { clientType: string }) => s.clientType)).toEqual(['mobile', 'web'])
    expect(sessions.body.items[0]).toMatchObject({ current: true, status: 'active' })
    expect(sessions.body.page.total).toBe(2)
  })

  it('rejects wrong passwords and unknown users with the same error, and never echoes the password', async () => {
    const { username } = await register()
    const wrong = await login(username, 'web', 'wrong password!!')
    const unknown = await login('nobody-here', 'web')
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
      expect(JSON.stringify(res.body)).not.toContain('wrong password')
    }
  })

  it('rate limits repeated attempts for the same username', async () => {
    const { username } = await register()
    const statuses: number[] = []
    for (let i = 0; i < 7; i += 1) statuses.push((await login(username, 'web', 'not the password')).status)
    expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })

  it('rejects disabled accounts', async () => {
    const { username } = await register()
    await withTenant(db, TENANT, (tx) => disableUser(tx, TENANT, username, null))
    const res = await login(username)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED')
  })
})

describe('logout and session state', () => {
  it('records the actual logout time, emits SessionRevoked and rejects the token afterwards', async () => {
    const { username } = await register()
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
    const { username, user } = await register()
    const { body } = await login(username)
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${body.accessToken}`)
    expect(me.status).toBe(200)
    expect(me.body.user).toMatchObject({ id: user.id, username, role: 'standard-user', isActive: true })
    expect(JSON.stringify(me.body)).not.toMatch(/password|argon2/)
  })

  it('rejects expired, foreign-signed and missing tokens', async () => {
    const { username } = await register()
    const { body } = await login(username)
    const expired = await tokenFor(keys, 'standard-user', { sub: body.user.id, sid: body.session.id, issuedAt: new Date(Date.now() - 31 * 60_000) })
    const foreign = await tokenFor(await createTestKeys(), 'standard-user', { sub: body.user.id, sid: body.session.id })
    for (const header of [expired.header, foreign.header]) {
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', header)
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_TOKEN')
    }
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401)
  })

  it('invalidates tokens issued before a role change, and emits UserRoleChanged', async () => {
    const { username, user } = await register()
    const { body } = await login(username)
    const { events } = await withTenant(db, TENANT, (tx) => changeRole(tx, TENANT, username, 'campaign-manager', null))
    const stale = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${body.accessToken}`)
    expect(stale.body.error.code).toBe('TOKEN_STALE')
    const fresh = await login(username)
    expect(fresh.body.user.role).toBe('campaign-manager')
    expect(events[0]).toMatchObject({
      eventType: 'UserRoleChanged',
      aggregateId: user.id,
      payload: { role: 'campaign-manager', previousRole: 'standard-user' },
    })
  })

  it('disabling a user ends their open sessions and emits SessionRevoked for each', async () => {
    const { username } = await register()
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
    const { user } = await register()
    const message = bus.published.find((m) => m.envelope.eventType === 'UserCreated' && m.key === user.id)
    expect(message).toMatchObject({ topic: 'auth.user.v1', envelope: { producer: 'auth-service', aggregateVersion: 1, eventVersion: 1 } })
  })

  it('publishes nothing when the transaction rolls back', async () => {
    const { username } = await register()
    const before = bus.published.length
    const dup = await registerRequest({ username, password: PASSWORD })
    expect(dup.status).toBe(409)
    expect(bus.published.length).toBe(before)
  })

  it('still succeeds when Kafka is unavailable (the event is logged and dropped)', async () => {
    const failing = createMemoryEventBus(logger)
    failing.publish = async () => {
      throw new Error('broker down')
    }
    const failingApp = buildAuthApp({ db, bus: failing, logger, privateKey: keys.privateKey, publicKey: keys.publicKey })
    const username = uniqueName()
    const res = await registerRequest({ username, password: PASSWORD }, TENANT, failingApp)
    expect(res.status).toBe(201)
    const { rows } = await queryAsTenant('SELECT count(*)::int AS n FROM users WHERE username = $1', [username])
    expect(rows[0].n).toBe(1)
  })
})

describe('tenant onboarding (/accounts)', () => {
  const onboard = (body: object) => request(app).post('/api/v1/accounts').send(body)
  const signIn = (tenant: string, username: string) =>
    request(app).post('/api/v1/auth/login').set('tenant_id', tenant).send({ username, password: 'test', clientType: 'web' })

  it('creates the account with a generated tenant ID and an onboarding campaign manager', async () => {
    const res = await onboard({ name: '  Acme Store ', tier: 'pro', dummyUsers: false })
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

  it('adds user01–user10 as standard users when asked, all signing in with "test"', async () => {
    const res = await onboard({ name: 'With demo users', tier: 'free', dummyUsers: true })
    expect(res.status).toBe(201)
    const tenant = res.body.account.tenantId as string
    expect(res.body.users.map((u: { username: string }) => u.username)).toEqual([
      'onboarding',
      ...Array.from({ length: 10 }, (_, i) => `user${String(i + 1).padStart(2, '0')}`),
    ])
    expect(res.body.users.slice(1).every((u: { role: string }) => u.role === 'standard-user')).toBe(true)
    const login = await signIn(tenant, 'user10')
    expect(login.body.user).toMatchObject({ username: 'user10', role: 'standard-user', tenantId: tenant })
    // The users belong to the new tenant only.
    expect((await signIn(TENANT, 'user10')).status).toBe(401)
    const { rows } = await queryAsTenant('SELECT count(*)::int AS n FROM users', [], tenant)
    expect(rows[0].n).toBe(11)
  })

  it('publishes TenantOnboarded with a random seed plan: 10–15 products, campaigns of 2 and 3 of them', async () => {
    const res = await onboard({ name: 'Seeded', tier: 'free', dummyUsers: false })
    const tenant = res.body.account.tenantId as string
    const message = bus.published.find((m) => m.envelope.eventType === 'TenantOnboarded' && m.key === tenant)!
    expect(message.topic).toBe('auth.tenant.v1')
    const payload = message.envelope.payload as { name: string; tier: string; onboardedBy: string; seed: { productIds: string[]; campaigns: { productIds: string[] }[] } }
    const onboardingUser = (await signIn(tenant, 'onboarding')).body.user.id
    expect(payload).toMatchObject({ tenantId: tenant, name: 'Seeded', tier: 'free', onboardedBy: onboardingUser })

    const { productIds, campaigns } = payload.seed
    expect(productIds.length).toBeGreaterThanOrEqual(10)
    expect(productIds.length).toBeLessThanOrEqual(15)
    expect(new Set(productIds).size).toBe(productIds.length)
    expect(campaigns.map((c) => c.productIds.length)).toEqual([2, 3])
    const inCampaigns = campaigns.flatMap((c) => c.productIds)
    expect(new Set(inCampaigns).size).toBe(5)
    expect(inCampaigns.every((id) => productIds.includes(id))).toBe(true)
    expect(res.body.seed).toEqual({ products: productIds.length, campaigns: 2 })
  })

  it('lists the onboarded accounts, newest first', async () => {
    const { body } = await onboard({ name: 'Newest', tier: 'enterprise', dummyUsers: false })
    const list = await request(app).get('/api/v1/accounts')
    expect(list.status).toBe(200)
    expect(list.body.items[0]).toEqual({ tenantId: body.account.tenantId, name: 'Newest', tier: 'enterprise', createdAt: body.account.createdAt })
    expect(list.body.items.map((a: { tenantId: string }) => a.tenantId)).toEqual(expect.arrayContaining([TENANT, OTHER_TENANT]))
  })

  it('validates the request, and never takes a tenant ID from the client', async () => {
    for (const body of [
      { name: '', tier: 'free', dummyUsers: false },
      { name: 'x', tier: 'gold', dummyUsers: false },
      { name: 'x', tier: 'free', dummyUsers: 'yes' },
      { name: 'x', tier: 'free', dummyUsers: false, tenantId: randomUUID() },
    ]) {
      const res = await onboard(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
  })
})

describe('seed plan', () => {
  it('is the same every time for a tenant (so seeding again creates nothing twice), and differs between tenants', () => {
    const tenant = randomUUID()
    expect(seedPlan(tenant)).toEqual(seedPlan(tenant))
    expect(seedPlan(randomUUID()).productIds).not.toEqual(seedPlan(tenant).productIds)
    const counts = new Set(Array.from({ length: 200 }, () => seedPlan(randomUUID()).productIds.length))
    expect([...counts].every((n) => n >= 10 && n <= 15)).toBe(true)
    expect(counts.size).toBeGreaterThan(1)
    expect(seedPlan(tenant).productIds.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true)
  })
})
