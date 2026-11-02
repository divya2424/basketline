import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { userLogin, users } from '../db/schema.ts'

export type Session = typeof userLogin.$inferSelect

export async function insertSession(
  db: DbOrTx,
  session: Pick<Session, 'id' | 'tenantId' | 'userId' | 'clientType' | 'sessionStartTime' | 'expiresAt'>,
): Promise<Session> {
  const [inserted] = await db.insert(userLogin).values(session).returning()
  return inserted!
}

/** Records the logout time; returns null if the session had already ended. */
export async function endSession(db: DbOrTx, sessionId: string, userId: string): Promise<Session | null> {
  const [ended] = await db
    .update(userLogin)
    .set({ sessionEndTime: sql`now()` })
    .where(and(eq(userLogin.id, sessionId), eq(userLogin.userId, userId), isNull(userLogin.sessionEndTime)))
    .returning()
  return ended ?? null
}

export function endOpenSessionsForUser(db: DbOrTx, userId: string): Promise<Session[]> {
  return db
    .update(userLogin)
    .set({ sessionEndTime: sql`now()` })
    .where(and(eq(userLogin.userId, userId), isNull(userLogin.sessionEndTime), gt(userLogin.expiresAt, sql`now()`)))
    .returning()
}

export async function listSessions(db: DbOrTx, userId: string, limit: number, offset: number) {
  const [items, [totals]] = await Promise.all([
    db.select().from(userLogin).where(eq(userLogin.userId, userId)).orderBy(desc(userLogin.sessionStartTime)).limit(limit).offset(offset),
    db.select({ total: count() }).from(userLogin).where(eq(userLogin.userId, userId)),
  ])
  return { items, total: totals?.total ?? 0 }
}

/** Session and account state, used to validate tokens issued by this service. */
export async function findSessionState(db: DbOrTx, sessionId: string, userId: string) {
  const [state] = await db
    .select({ sessionEndTime: userLogin.sessionEndTime, isActive: users.isActive, role: users.role })
    .from(userLogin)
    .innerJoin(users, eq(users.id, userLogin.userId))
    .where(and(eq(userLogin.id, sessionId), eq(userLogin.userId, userId)))
  return state ?? null
}
