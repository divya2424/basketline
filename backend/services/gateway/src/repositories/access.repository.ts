import { eq, lt, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { deletedTenants, revokedSessions, tenantOrigins, userAccessState } from '../db/schema.ts'

export async function isSessionRevoked(db: DbOrTx, sessionId: string): Promise<boolean> {
  const [row] = await db.select({ sessionId: revokedSessions.sessionId }).from(revokedSessions).where(eq(revokedSessions.sessionId, sessionId))
  return row !== undefined
}

export async function findUserAccessState(db: DbOrTx, userId: string) {
  const [state] = await db.select().from(userAccessState).where(eq(userAccessState.userId, userId))
  return state ?? null
}

export async function insertRevokedSession(db: DbOrTx, session: { sessionId: string; userId: string; revokedAt: string; expiresAt: string }) {
  await db
    .insert(revokedSessions)
    .values({ ...session, revokedAt: new Date(session.revokedAt), expiresAt: new Date(session.expiresAt) })
    .onConflictDoNothing()
}

/** Disabling is permanent here, so it applies regardless of order. */
export async function markUserDisabled(db: DbOrTx, userId: string, version: number) {
  await db
    .insert(userAccessState)
    .values({ userId, disabled: true, version })
    .onConflictDoUpdate({
      target: userAccessState.userId,
      set: { disabled: true, version: sql`greatest(${userAccessState.version}, excluded.version)` },
    })
}

/** Only moves forward: an older role change can't undo a newer one. */
export async function setTokensNotBefore(db: DbOrTx, userId: string, at: string, version: number) {
  const values = { tokensNotBefore: new Date(at), version }
  await db
    .insert(userAccessState)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userAccessState.userId, set: values, setWhere: lt(userAccessState.version, sql`excluded.version`) })
}

export async function deleteExpiredRevocations(db: DbOrTx): Promise<number> {
  const deleted = await db.delete(revokedSessions).where(lt(revokedSessions.expiresAt, sql`now()`)).returning({ id: revokedSessions.sessionId })
  return deleted.length
}

export async function isTenantDeleted(db: DbOrTx, tenantId: string): Promise<boolean> {
  const [row] = await db.select({ tenantId: deletedTenants.tenantId }).from(deletedTenants).where(eq(deletedTenants.tenantId, tenantId))
  return row !== undefined
}

export async function insertDeletedTenant(db: DbOrTx, tenant: { tenantId: string; deletedAt: string }) {
  await db.insert(deletedTenants).values({ tenantId: tenant.tenantId, deletedAt: new Date(tenant.deletedAt) }).onConflictDoNothing()
}

export async function findTenantOrigins(db: DbOrTx, tenantId: string): Promise<string[]> {
  const [row] = await db.select({ origins: tenantOrigins.origins }).from(tenantOrigins).where(eq(tenantOrigins.tenantId, tenantId))
  return row?.origins ?? []
}

/** Only moves forward: an older list can't replace a newer one. */
export async function upsertTenantOrigins(db: DbOrTx, change: { tenantId: string; origins: string[]; version: number }) {
  await db
    .insert(tenantOrigins)
    .values(change)
    .onConflictDoUpdate({ target: tenantOrigins.tenantId, set: { origins: change.origins, version: change.version }, setWhere: lt(tenantOrigins.version, sql`excluded.version`) })
}
