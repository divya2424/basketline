import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb, runMigrations, type Database, type Logger, type Transaction } from '@shopsphere/platform'
import * as schema from './schema.ts'

export const createAuthDb = (url: string, logger?: Logger) => createDb(url, schema, logger)
export const migrateAuthDb = (db: Db) => runMigrations(db, path.join(import.meta.dirname, '../../drizzle'))

export type Db = Database<typeof schema>
export type Tx = Transaction<Db>
export type DbOrTx = Db | Tx

/**
 * Runs fn in a transaction that can see one tenant's users and user_login rows.
 * Row-level security (schema.ts) hides every row outside it, and all rows when
 * no tenant is set. set_config(…, true) lasts until the transaction ends, so
 * the setting never leaks to the next user of the pooled connection.
 */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
    return fn(tx)
  })
}
