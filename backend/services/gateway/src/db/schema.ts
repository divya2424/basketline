/**
 * gateway_db tables: the gateway's own view of session and account state,
 * maintained from auth.session.v1 / auth.user.v1 events (never by calling the
 * auth service). After a change run `pnpm --filter @basketline/gateway db:generate`.
 */
import { bigint, boolean, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { timestamptz } from '@basketline/platform'

export { processedEvents } from '@basketline/platform'

export const revokedSessions = pgTable(
  'revoked_sessions',
  {
    sessionId: uuid('session_id').primaryKey(),
    userId: uuid('user_id').notNull(),
    revokedAt: timestamptz('revoked_at').notNull(),
    // After this the token has expired anyway, so the row can be deleted.
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [index('revoked_sessions_expires_idx').on(table.expiresAt)],
)

export const userAccessState = pgTable('user_access_state', {
  userId: uuid('user_id').primaryKey(),
  disabled: boolean('disabled').notNull().default(false),
  // Tokens issued before this (e.g. before a role change) are rejected.
  tokensNotBefore: timestamptz('tokens_not_before'),
  version: bigint('version', { mode: 'number' }).notNull(),
})

/** Deleted tenants (TenantDeleted): their tokens, still unexpired, are refused. */
export const deletedTenants = pgTable('deleted_tenants', {
  tenantId: uuid('tenant_id').primaryKey(),
  deletedAt: timestamptz('deleted_at').notNull(),
})

/** Each tenant's allowed websites (TenantOriginsChanged); no row or an empty list: any. */
export const tenantOrigins = pgTable('tenant_origins', {
  tenantId: uuid('tenant_id').primaryKey(),
  origins: text('origins').array().notNull(),
  version: integer('version').notNull(),
})
