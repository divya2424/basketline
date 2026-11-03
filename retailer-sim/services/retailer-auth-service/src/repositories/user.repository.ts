import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { users } from '../db/schema.ts'

export type User = typeof users.$inferSelect

export async function insertUser(db: DbOrTx, user: Pick<User, 'id' | 'tenantId' | 'username' | 'passwordHash' | 'role'> & Partial<Pick<User, 'sellerId'>>): Promise<User> {
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

/** A store's sellers' and customers' logins (never staff), sellers first, by name. */
export function listDemoLogins(db: DbOrTx, tenantId: string) {
  return db
    .select({ username: users.username, role: users.role, sellerId: users.sellerId })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), ne(users.role, 'staff')))
    .orderBy(desc(users.role), asc(users.username))
}
