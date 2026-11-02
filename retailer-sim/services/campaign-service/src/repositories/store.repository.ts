import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { stores } from '../db/schema.ts'

/** A connected store's sealed API key; a store connected again (a new key) replaces it. */
export async function saveStore(db: DbOrTx, tenantId: string, sealedApiKey: string): Promise<void> {
  await db.insert(stores).values({ tenantId, sealedApiKey }).onConflictDoUpdate({ target: stores.tenantId, set: { sealedApiKey } })
}

export async function findSealedApiKey(db: DbOrTx, tenantId: string): Promise<string | null> {
  const [store] = await db.select({ sealedApiKey: stores.sealedApiKey }).from(stores).where(eq(stores.tenantId, tenantId))
  return store?.sealedApiKey ?? null
}
