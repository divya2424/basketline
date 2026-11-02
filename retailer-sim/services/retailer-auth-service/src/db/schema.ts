/**
 * retailer_auth_db tables — the source of truth for the schema. After a change run
 * `pnpm --filter @retailer-sim/retailer-auth-service db:generate`; migrations apply on startup.
 */
import { sql } from 'drizzle-orm'
import { index, pgEnum, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
// The tables module, not the package root: drizzle-kit loads this file with require(),
// and the root also loads the Kafka bus, which is ESM only.
import { timestamptz } from '@basketline/platform/tables'

// RETAILER_ROLES (@retailer-sim/shared), which drizzle-kit can't load.
export const userRole = pgEnum('user_role', ['customer', 'staff'])

/** The retailer's stores, each connected to Basketline: its tenant there, and its API key, sealed. */
export const stores = pgTable('stores', {
  tenantId: uuid('tenant_id').primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  tier: varchar('tier', { length: 20 }).notNull(),
  sealedApiKey: text('sealed_api_key').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
})

/** A store's customers and staff: the retailer's own logins, never Basketline users. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => stores.tenantId),
    username: varchar('username', { length: 100 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: userRole('role').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  // Usernames are unique within a store, regardless of case.
  (table) => [uniqueIndex('users_username_unique').on(table.tenantId, sql`lower(${table.username})`), index('users_tenant_idx').on(table.tenantId)],
)
