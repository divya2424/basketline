/**
 * gateway_db tables: the gateway's own view of session and account state,
 * maintained from auth.session.v1 / auth.user.v1 events (never by calling the
 * auth service). After a change run `npm run db:generate -w @ecommerce-analytics/gateway`.
 */
import { bigint, boolean, index, pgTable, uuid } from 'drizzle-orm/pg-core'
import { timestamptz } from '@ecommerce-analytics/platform'

export { processedEvents } from '@ecommerce-analytics/platform'

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
