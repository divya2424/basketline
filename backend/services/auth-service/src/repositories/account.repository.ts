import { desc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { accounts } from '../db/schema.ts'

export type Account = typeof accounts.$inferSelect

export async function findAccount(db: DbOrTx, tenantId: string): Promise<Account | null> {
  const [account] = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId))
  return account ?? null
}

export async function insertAccount(db: DbOrTx, account: Pick<Account, 'tenantId' | 'name' | 'tier'>): Promise<Account> {
  const [inserted] = await db.insert(accounts).values(account).returning()
  return inserted!
}

/** Every account, newest first. */
export function listAccounts(db: DbOrTx): Promise<Account[]> {
  return db.select().from(accounts).orderBy(desc(accounts.createdAt), accounts.tenantId)
}
