import { randomUUID } from 'node:crypto'
import type { AddressInfo, Server } from 'node:net'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '@shopsphere/contracts'
import { closeDb, createLogger, idempotentHandler } from '@shopsphere/platform'
import { createTestDatabase, createTestKeys, tokenFor, visitorTokenFor, type TestKeys } from '@shopsphere/platform/testing'
import { buildGateway } from '../src/app.ts'
import { createGatewayDb, migrateGatewayDb, type Db } from '../src/db/client.ts'
import { handleAccessEvent } from '../src/events/access.consumer.ts'

interface Hit {
  service: string
  method: string
  url: string
  headers: Record<string, unknown>
  body: unknown
}

let testDb: Awaited<ReturnType<typeof createTestDatabase>>
let db: Db
let keys: TestKeys
let gateway: ReturnType<typeof buildGateway>['app']
let hits: Hit[] = []
const upstreams: Server[] = []
let apply: (envelope: EventEnvelope) => Promise<void>

/** A fake service that records every request and echoes it back. */
async function fakeService(name: string): Promise<string> {
  const app = express()
  app.use(express.json())
  app.use((req, res) => {
    const hit = { service: name, method: req.method, url: req.originalUrl, headers: req.headers, body: req.body }
    hits.push(hit)
    res.status(200).json({ from: name, url: req.originalUrl })
  })
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  upstreams.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  db = createGatewayDb(testDb.url)
  await migrateGatewayDb(db)
  keys = await createTestKeys()
  const services = {
    auth: await fakeService('auth'),
    product: await fakeService('product'),
    campaign: await fakeService('campaign'),
    analytics: await fakeService('analytics'),
  }
  gateway = buildGateway({ db, logger: createLogger('gateway-test'), publicKey: keys.publicKey, services, corsOrigins: ['http://localhost:5173'] }).app
  const handler = idempotentHandler(db, handleAccessEvent)
  apply = (envelope) => handler(envelope, { topic: 'auth.session.v1', partition: 0, offset: '0' })
})

afterAll(async () => {
  await Promise.all(upstreams.map((server) => new Promise((resolve) => server.close(resolve))))
  await closeDb(db)
  await testDb.drop()
})

beforeEach(() => {
  hits = []
})

function authEvent(eventType: string, userId: string, version: number, payload: object): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'auth-service',
    aggregateId: userId,
    aggregateVersion: version,
    payload: { userId, ...payload },
  }
}

describe('routing', () => {
  it('sends each path prefix to exactly one service, keeping the full path', async () => {
    const user = await tokenFor(keys, 'campaign-manager')
    const cases: [string, string][] = [
      ['/api/v1/auth/me', 'auth'],
      ['/api/v1/products?limit=5', 'product'],
      ['/api/v1/campaigns/abc/products', 'campaign'],
      ['/api/v1/ad/abc/clicks?from=2026-10-01T00:00:00Z', 'analytics'],
      ['/api/v1/analytics/campaigns/abc/timeseries?metric=clicks', 'analytics'],
    ]
    for (const [url, service] of cases) {
      hits = []
      const res = await request(gateway).get(url).set('Authorization', user.header)
      expect(res.body, url).toEqual({ from: service, url })
      expect(hits).toHaveLength(1)
    }
  })

  it('passes request bodies through unchanged', async () => {
    const res = await request(gateway)
      .post('/api/v1/auth/login')
      .send({ username: 'maya', password: 'correct horse battery', clientType: 'web' })
    expect(res.status).toBe(200)
    expect(hits[0]).toMatchObject({ service: 'auth', method: 'POST', body: { username: 'maya', clientType: 'web' } })
  })

  it('returns 404 for paths no service exposes, without forwarding', async () => {
    expect((await request(gateway).get('/api/v1/orders')).status).toBe(404)
    expect((await request(gateway).delete('/api/v1/analytics/events')).status).toBe(404)
    expect(hits).toHaveLength(0)
  })
})

describe('permissions', () => {
  it('lets anyone register, log in and get a visitor token', async () => {
    for (const url of ['/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/auth/visitor']) {
      expect((await request(gateway).post(url).send({})).status, url).toBe(200)
    }
  })

  it('lets anyone list and onboard tenants (auth-service), and nothing else on /accounts', async () => {
    hits = []
    expect((await request(gateway).get('/api/v1/accounts')).body).toEqual({ from: 'auth', url: '/api/v1/accounts' })
    expect((await request(gateway).post('/api/v1/accounts').send({ name: 'Acme' })).body).toEqual({ from: 'auth', url: '/api/v1/accounts' })
    expect(hits).toHaveLength(2)
    expect((await request(gateway).delete('/api/v1/accounts')).status).toBe(404)
    expect((await request(gateway).get('/api/v1/accounts/abc')).status).toBe(404)
    expect(hits).toHaveLength(2)
  })

  it('takes analytics events with an access or a visitor token, never without one', async () => {
    const events = (auth?: string) => {
      const req = request(gateway).post('/api/v1/analytics/events')
      if (auth) req.set('Authorization', auth)
      return req.send({ events: [] })
    }
    expect((await events((await visitorTokenFor(keys)).header)).status).toBe(200)
    expect((await events((await tokenFor(keys, 'standard-user')).header)).status).toBe(200)
    hits = []
    expect((await events()).status).toBe(401)
    expect((await events('Bearer nonsense')).status).toBe(401)
    expect((await events((await visitorTokenFor(await createTestKeys())).header)).status).toBe(401)
    expect(hits).toHaveLength(0)
  })

  it('limits campaign metrics to campaign managers', async () => {
    const path = '/api/v1/ad/abc/clicks'
    expect((await request(gateway).get(path).set('Authorization', (await tokenFor(keys, 'standard-user')).header)).status).toBe(403)
    expect((await request(gateway).get(path).set('Authorization', (await visitorTokenFor(keys)).header)).status).toBe(401)
    expect((await request(gateway).get(path).set('Authorization', (await tokenFor(keys, 'campaign-manager')).header)).status).toBe(200)
  })

  it('allows anonymous catalog reads, requires a token for metrics and the campaign-manager role for writes', async () => {
    const user = await tokenFor(keys, 'standard-user')
    const manager = await tokenFor(keys, 'campaign-manager')
    expect((await request(gateway).get('/api/v1/products')).status).toBe(200)
    expect((await request(gateway).get('/api/v1/campaigns')).status).toBe(200)
    hits = []
    expect((await request(gateway).get('/api/v1/ad/abc/clicks')).status).toBe(401)
    expect((await request(gateway).get('/api/v1/products').set('Authorization', 'Bearer nonsense')).status).toBe(401)
    expect((await request(gateway).post('/api/v1/products').send({})).status).toBe(401)
    expect((await request(gateway).post('/api/v1/campaigns').set('Authorization', user.header).send({})).status).toBe(403)
    expect(hits).toHaveLength(0)
    expect((await request(gateway).post('/api/v1/campaigns').set('Authorization', manager.header).send({})).status).toBe(200)
  })

  it('sets user_id from the token and drops a client-supplied one; passes tenant_id through', async () => {
    const user = await tokenFor(keys, 'standard-user')
    await request(gateway).get('/api/v1/products').set('Authorization', user.header).set('user_id', 'spoofed').set('tenant_id', 'tenant_acme')
    expect(hits[0]!.headers).toMatchObject({ user_id: user.sub, tenant_id: 'tenant_acme' })
    const visitor = await visitorTokenFor(keys)
    await request(gateway).post('/api/v1/analytics/events').set('Authorization', visitor.header).set('user_id', 'spoofed').send({ events: [] })
    expect(hits[1]!.headers.user_id).toBeUndefined()
  })
})

describe('revocation (from auth events, no calls to the auth service)', () => {
  it('rejects a token once its session is revoked', async () => {
    const user = await tokenFor(keys, 'standard-user')
    expect((await request(gateway).get('/api/v1/products').set('Authorization', user.header)).status).toBe(200)
    await apply(authEvent('SessionRevoked', user.sub, 1, { sessionId: user.sid, revokedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_800_000).toISOString() }))
    const res = await request(gateway).get('/api/v1/products').set('Authorization', user.header)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('SESSION_REVOKED')
    // A revoked user can't send events with that token either.
    const events = await request(gateway).post('/api/v1/analytics/events').set('Authorization', user.header).send({ events: [] })
    expect(events.body.error.code).toBe('SESSION_REVOKED')
  })

  it('rejects all tokens of a disabled user', async () => {
    const user = await tokenFor(keys, 'standard-user')
    await apply(authEvent('UserDisabled', user.sub, 2, { disabledAt: new Date().toISOString() }))
    expect((await request(gateway).get('/api/v1/products').set('Authorization', user.header)).body.error.code).toBe('ACCOUNT_DISABLED')
  })

  it('rejects tokens issued before a role change, but accepts new ones', async () => {
    const userId = randomUUID()
    const old = await tokenFor(keys, 'standard-user', { sub: userId, issuedAt: new Date(Date.now() - 60_000) })
    await apply(authEvent('UserRoleChanged', userId, 2, { role: 'campaign-manager', previousRole: 'standard-user', changedAt: new Date(Date.now() - 30_000).toISOString() }))
    expect((await request(gateway).get('/api/v1/products').set('Authorization', old.header)).body.error.code).toBe('TOKEN_STALE')
    const fresh = await tokenFor(keys, 'campaign-manager', { sub: userId })
    expect((await request(gateway).get('/api/v1/products').set('Authorization', fresh.header)).status).toBe(200)
  })
})

describe('edge protection', () => {
  it('answers CORS preflight for the frontend, allowing tenant_id and user_id', async () => {
    const res = await request(gateway)
      .options('/api/v1/products')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,tenant_id')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(res.headers['access-control-allow-headers']).toContain('tenant_id')
  })

  it('rejects oversized bodies before forwarding', async () => {
    const res = await request(gateway).post('/api/v1/analytics/events').set('Content-Type', 'application/json').send('x'.repeat(200 * 1024))
    expect(res.status).toBe(413)
    expect(hits).toHaveLength(0)
  })

  it('returns 502 when a service is down', async () => {
    const down = buildGateway({
      db,
      logger: createLogger('gateway-test'),
      publicKey: keys.publicKey,
      services: { auth: 'http://127.0.0.1:1', product: 'http://127.0.0.1:1', campaign: 'http://127.0.0.1:1', analytics: 'http://127.0.0.1:1' },
      corsOrigins: [],
    }).app
    const res = await request(down).post('/api/v1/auth/login').send({})
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('BAD_GATEWAY')
  })
})
