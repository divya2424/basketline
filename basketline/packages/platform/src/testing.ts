import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { exportPKCS8, exportSPKI, generateKeyPair, type CryptoKey } from 'jose'
import pg from 'pg'
import type { ClientType, Role } from '@basketline/contracts'
import { createClickHouse, type ClickHouse } from './clickhouse.ts'
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
  overrides: { sub?: string; sid?: string; tid?: string; client?: ClientType; issuedAt?: Date; ttlSeconds?: number } = {},
) {
  const sub = overrides.sub ?? randomUUID()
  const sid = overrides.sid ?? randomUUID()
  const tid = overrides.tid ?? randomUUID()
  const client = overrides.client ?? 'web'
  const { token } = await signAccessToken(keys.privateKey, { sub, sid, role, tid, client }, overrides.issuedAt, overrides.ttlSeconds)
  return { token, sub, sid, tid, header: `Bearer ${token}` }
}

export async function visitorTokenFor(keys: TestKeys, tid: string = randomUUID(), client: ClientType = 'web') {
  const sub = randomUUID()
  const { token } = await signVisitorToken(keys.privateKey, { tenantId: tid, visitorId: sub, client })
  return { token, sub, tid, header: `Bearer ${token}` }
}

const CLICKHOUSE_URL = process.env.TEST_CLICKHOUSE_URL ?? 'http://basketline:basketline_dev@localhost:8123'
const CLICKHOUSE_SCHEMA = path.join(import.meta.dirname, '../../../infra/clickhouse')

/** A schema file's statements, for a database and reader user of the test's own. */
function statements(file: string, database: string, readerUser: string): string[] {
  return readFileSync(path.join(CLICKHOUSE_SCHEMA, file), 'utf8')
    .replace(/--.*$/gm, '')
    .replaceAll(/\banalytics\b/g, database)
    .replaceAll('basketline_reader_dev', 'reader_test_password')
    .replaceAll(/\bbasketline_reader\b/g, readerUser)
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

/**
 * A throwaway ClickHouse database with the real schema (infra/clickhouse: tables,
 * materialized views and the tenant-scoped reader of 04_access.sql, without the
 * Kafka tables). clickhouse: the services' own user (writes); reader: the reader
 * user, which sees one tenant per query (SQL_tenant_id). Call drop() when done.
 */
export async function createTestClickHouse(): Promise<{ database: string; clickhouse: ClickHouse; reader: ClickHouse; drop: () => Promise<void> }> {
  const database = `analytics_test_${randomUUID().replaceAll('-', '')}`
  const readerUser = `reader_${database}`
  const admin = createClickHouse(CLICKHOUSE_URL)
  for (const file of ['01_tables.sql', '02_materialized_views.sql', '04_access.sql']) {
    for (const query of statements(file, database, readerUser)) await admin.command({ query })
  }
  const readerUrl = new URL(CLICKHOUSE_URL)
  readerUrl.username = readerUser
  readerUrl.password = 'reader_test_password'
  const clickhouse = createClickHouse(`${CLICKHOUSE_URL}/${database}`)
  const reader = createClickHouse(`${readerUrl.toString().replace(/\/$/, '')}/${database}`)
  return {
    database,
    clickhouse,
    reader,
    async drop() {
      await clickhouse.close()
      await reader.close()
      // Row policies outlive their database, so they go one by one.
      const policies = await (await admin.query({ query: 'SELECT short_name, table FROM system.row_policies WHERE database = {db:String}', query_params: { db: database }, format: 'JSONEachRow' })).json<{ short_name: string; table: string }>()
      for (const { short_name, table } of policies) await admin.command({ query: `DROP ROW POLICY IF EXISTS ${short_name} ON ${database}.${table}` })
      await admin.command({ query: `DROP USER IF EXISTS ${readerUser}` })
      await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await admin.close()
    },
  }
}
