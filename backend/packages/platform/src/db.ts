/**
 * Database helpers shared by every service. Each service has its own schema
 * (src/db/schema.ts), its own database, and its own drizzle-kit migrations.
 */
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type pg from 'pg'
import type { Logger } from './logger.ts'

export type Database<TSchema extends Record<string, unknown> = Record<string, unknown>> = NodePgDatabase<TSchema> & {
  $client: pg.Pool
}
/** The handle passed to db.transaction() callbacks. */
export type Transaction<D extends Database<any>> = Parameters<Parameters<D['transaction']>[0]>[0]

/** Drizzle client with its own connection pool (db.$client). */
export function createDb<TSchema extends Record<string, unknown>>(url: string, schema: TSchema, logger?: Logger): Database<TSchema> {
  const db = drizzle({ connection: { connectionString: url, max: 10, idleTimeoutMillis: 30_000 }, schema })
  db.$client.on('error', (error) => logger?.error({ err: error }, 'idle postgres client error'))
  return db
}

/** Applies the drizzle-kit migrations in `folder` (a service's ./drizzle directory). */
export function runMigrations(db: Database<any>, folder: string): Promise<void> {
  return migrate(db, { migrationsFolder: folder })
}

/** Readiness check: throws if the database can't be reached. */
export async function pingDb(db: Database<any>): Promise<void> {
  await db.execute(sql`select 1`)
}

export function closeDb(db: Database<any>): Promise<void> {
  return db.$client.end()
}

/** True for a Postgres unique violation (optionally on one constraint). Drizzle puts the pg error in .cause. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = ((error as { cause?: unknown })?.cause ?? error) as { code?: string; constraint?: string }
  return pgError?.code === '23505' && (constraint === undefined || pgError.constraint === constraint)
}
