import { randomUUID } from 'node:crypto'
import { exportPKCS8, exportSPKI, generateKeyPair, type CryptoKey } from 'jose'
import pg from 'pg'
import type { Role } from '@ecommerce-analytics/contracts'
import { JWT_ALGORITHM, signAccessToken, signVisitorToken } from './jwt.ts'

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'

/**
 * Creates an empty, uniquely named database, owned by and connected as a new
 * non-superuser login, like a service's own (superusers skip row-level
 * security). Call drop() when done.
 */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const password = randomUUID()
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`)
  await admin.query(`CREATE DATABASE ${name} OWNER ${name}`)
  await admin.end()
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  url.username = name
  url.password = password
  return {
    url: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: ADMIN_URL })
      await client.connect()
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await client.query(`DROP ROLE IF EXISTS ${name}`)
      await client.end()
    },
  }
}

export interface TestKeys {
  privateKey: CryptoKey
  publicKey: CryptoKey
  privatePem: string
  publicPem: string
}

export async function createTestKeys(): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair(JWT_ALGORITHM, { extractable: true })
  return { privateKey, publicKey, privatePem: await exportPKCS8(privateKey), publicPem: await exportSPKI(publicKey) }
}

export async function tokenFor(
  keys: TestKeys,
  role: Role,
  overrides: { sub?: string; sid?: string; tid?: string; issuedAt?: Date; ttlSeconds?: number } = {},
) {
  const sub = overrides.sub ?? randomUUID()
  const sid = overrides.sid ?? randomUUID()
  const tid = overrides.tid ?? randomUUID()
  const { token } = await signAccessToken(keys.privateKey, { sub, sid, role, tid }, overrides.issuedAt, overrides.ttlSeconds)
  return { token, sub, sid, tid, header: `Bearer ${token}` }
}

export async function visitorTokenFor(keys: TestKeys, tid: string = randomUUID()) {
  const { token } = await signVisitorToken(keys.privateKey, tid)
  return { token, tid, header: `Bearer ${token}` }
}
