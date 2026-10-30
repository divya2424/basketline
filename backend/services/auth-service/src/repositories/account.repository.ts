import { desc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { accounts, apiKeys, externalCustomers, userLogin, users } from '../db/schema.ts'

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

/**
 * Deletes the tenant's rows from identity_db (sessions, users, API keys,
 * customer mappings) and then the account. Run inside withTenant for the
 * tenant: row-level security limits every delete to its rows.
 */
export async function deleteAccountData(db: DbOrTx, tenantId: string): Promise<void> {
  await db.delete(userLogin).where(eq(userLogin.tenantId, tenantId))
  await db.delete(users).where(eq(users.tenantId, tenantId))
  await db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId))
  await db.delete(externalCustomers).where(eq(externalCustomers.tenantId, tenantId))
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId))
}
