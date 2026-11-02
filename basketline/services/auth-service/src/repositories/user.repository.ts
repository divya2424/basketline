import { and, eq, sql } from 'drizzle-orm'
import type { Role } from '@basketline/contracts'
import type { DbOrTx } from '../db/client.ts'
import { users } from '../db/schema.ts'

export type User = typeof users.$inferSelect

/** Usernames are matched case-insensitively, within one tenant. */
export async function findUserByUsername(db: DbOrTx, tenantId: string, username: string, { forUpdate = false } = {}): Promise<User | null> {
  const query = db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(sql`lower(${users.username})`, username.trim().toLowerCase())))
  const [user] = forUpdate ? await query.for('update') : await query
  return user ?? null
}

export async function findUserById(db: DbOrTx, id: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id))
  return user ?? null
}

/** Throws a unique violation on users_username_unique if the name is taken. */
export async function insertUser(db: DbOrTx, user: Pick<User, 'id' | 'username' | 'passwordHash' | 'role' | 'tenantId'>): Promise<User> {
  const [inserted] = await db.insert(users).values(user).returning()
  return inserted!
}

/** Applies a change and bumps the version (used by role changes and disabling). */
async function updateUser(db: DbOrTx, id: string, changes: Partial<Pick<User, 'role' | 'isActive'>>): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ ...changes, updatedAt: sql`now()`, version: sql`${users.version} + 1` })
    .where(eq(users.id, id))
    .returning()
  return updated!
}

export const updateUserRole = (db: DbOrTx, id: string, role: Role) => updateUser(db, id, { role })
export const deactivateUser = (db: DbOrTx, id: string) => updateUser(db, id, { isActive: false })

export async function setLastLogin(db: DbOrTx, id: string, at: Date): Promise<void> {
  await db.update(users).set({ lastLoginAt: at }).where(eq(users.id, id))
}
