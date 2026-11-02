import { and, eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { users } from '../db/schema.ts'

export type User = typeof users.$inferSelect

export async function insertUser(db: DbOrTx, user: Pick<User, 'id' | 'tenantId' | 'username' | 'passwordHash' | 'role'>): Promise<User> {
  const [inserted] = await db.insert(users).values(user).returning()
  return inserted!
}

/** Usernames are per store and case-insensitive. */
export async function findUserByUsername(db: DbOrTx, tenantId: string, username: string): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(sql`lower(${users.username})`, username.trim().toLowerCase())))
  return user ?? null
}
