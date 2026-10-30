import { and, desc, eq, isNull } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { apiKeys, externalCustomers, users } from '../db/schema.ts'

export type ApiKey = typeof apiKeys.$inferSelect

export async function insertApiKey(db: DbOrTx, key: Pick<ApiKey, 'id' | 'tenantId' | 'name' | 'keyHash' | 'prefix'>): Promise<ApiKey> {
  const [inserted] = await db.insert(apiKeys).values(key).returning()
  return inserted!
}

/** The tenant's key with this hash, unless it was revoked. */
export async function findActiveApiKey(db: DbOrTx, tenantId: string, keyHash: string): Promise<ApiKey | null> {
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
  return key ?? null
}

export function listApiKeys(db: DbOrTx, tenantId: string): Promise<ApiKey[]> {
  return db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId)).orderBy(desc(apiKeys.createdAt))
}

/** Revokes the tenant's active keys with this prefix; returns how many. */
export async function revokeApiKeys(db: DbOrTx, tenantId: string, prefix: string): Promise<number> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id })
  return revoked.length
}

export async function findExternalCustomer(db: DbOrTx, tenantId: string, customerId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: externalCustomers.userId })
    .from(externalCustomers)
    .where(and(eq(externalCustomers.tenantId, tenantId), eq(externalCustomers.customerId, customerId)))
  return row?.userId ?? null
}

/** Whether the UUID is already someone in the tenant: a vendor's customer or a Basketline user. */
export async function isUserIdTaken(db: DbOrTx, tenantId: string, userId: string): Promise<boolean> {
  const [customer] = await db
    .select({ userId: externalCustomers.userId })
    .from(externalCustomers)
    .where(and(eq(externalCustomers.tenantId, tenantId), eq(externalCustomers.userId, userId)))
  if (customer) return true
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId))
  return Boolean(user)
}

export async function insertExternalCustomer(db: DbOrTx, row: { tenantId: string; customerId: string; userId: string }) {
  await db.insert(externalCustomers).values(row)
}
