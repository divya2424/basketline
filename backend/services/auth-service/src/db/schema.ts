/**
 * identity_db tables — the source of truth for the schema. After a change run
 * `npm run db:generate -w @basketline/auth-service`; migrations apply on startup.
 */
import { sql } from 'drizzle-orm'
import { bigint, boolean, index, integer, pgEnum, pgPolicy, pgTable, primaryKey, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { ROLES } from '@basketline/contracts'
import { timestamptz } from '@basketline/platform'

export { auditLog } from '@basketline/platform'

export const userRole = pgEnum('user_role', ROLES)
export const clientType = pgEnum('client_type', ['web', 'mobile'])
export const accountTier = pgEnum('account_tier', ['free', 'pro', 'enterprise'])

/** One row per tenant (storefront). Created with `cli.ts create-account`. */
export const accounts = pgTable('accounts', {
  tenantId: uuid('tenant_id').primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  tier: accountTier('tier').notNull().default('free'),
  /** Websites allowed to send the tenant's events from the browser (empty: any); see TenantOriginsChanged. */
  allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),
  originsVersion: integer('origins_version').notNull().default(0),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
})

/**
 * Row-level security on users and user_login: a row is visible (and writable)
 * only when its tenant is the transaction's app.tenant_id, set by withTenant()
 * in db/client.ts. Without it, no rows. nullif: a pooled connection reads ''
 * once an earlier transaction has set and reset it.
 */
const tenantIsolation = () => {
  const tenantMatches = sql`tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
  return pgPolicy('tenant_isolation', { for: 'all', using: tenantMatches, withCheck: tenantMatches })
}

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    username: varchar('username', { length: 100 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: userRole('role').notNull().default('standard-user'),
    // The storefront the user signed up at; carried in their tokens as "tid".
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => accounts.tenantId),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    lastLoginAt: timestamptz('last_login_at'),
    // Bumped by role changes and disabling; orders the user's events.
    version: bigint('version', { mode: 'number' }).notNull().default(1),
  },
  // Usernames are unique within a tenant, regardless of case.
  (table) => [uniqueIndex('users_username_unique').on(table.tenantId, sql`lower(${table.username})`), tenantIsolation()],
).enableRLS()

/** One row per login (PRD: user_login). */
export const userLogin = pgTable(
  'user_login',
  {
    id: uuid('id').primaryKey(),
    // The user's tenant.
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => accounts.tenantId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    clientType: clientType('client_type').notNull(),
    sessionStartTime: timestamptz('session_start_time').notNull(),
    sessionEndTime: timestamptz('session_end_time'),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [index('user_login_user_idx').on(table.tenantId, table.userId, table.sessionStartTime.desc()), tenantIsolation()],
).enableRLS()

/**
 * A vendor's secret API keys, for its backend to vouch for its signed-in
 * customers (POST /auth/shopper-token). The key itself is shown once; only its
 * SHA-256 hash is kept (enough for a key with 256 random bits), and its first
 * characters (prefix) to tell keys apart. Revoked keys are kept, for the audit.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => accounts.tenantId),
    name: varchar('name', { length: 100 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    prefix: varchar('prefix', { length: 16 }).notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [uniqueIndex('api_keys_hash_unique').on(table.keyHash), tenantIsolation()],
).enableRLS()

/**
 * A vendor's customer (its own ID for them) and the UUID Basketline counts them
 * as. Set on the first shopper token, to the visitor's UUID when the vendor
 * passes it, so the visitor and the signed-in customer stay one person.
 */
export const externalCustomers = pgTable(
  'external_customers',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => accounts.tenantId),
    customerId: varchar('customer_id', { length: 200 }).notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.customerId] }),
    uniqueIndex('external_customers_user_unique').on(table.tenantId, table.userId),
    tenantIsolation(),
  ],
).enableRLS()
