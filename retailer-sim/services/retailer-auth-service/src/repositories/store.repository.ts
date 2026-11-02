import { desc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { stores } from '../db/schema.ts'

export type Store = typeof stores.$inferSelect

export async function insertStore(db: DbOrTx, store: Pick<Store, 'tenantId' | 'name' | 'tier' | 'sealedApiKey'>): Promise<Store> {
  const [inserted] = await db.insert(stores).values(store).returning()
  return inserted!
}

export async function findStore(db: DbOrTx, tenantId: string): Promise<Store | null> {
  const [store] = await db.select().from(stores).where(eq(stores.tenantId, tenantId))
  return store ?? null
}

/** Newest first. */
export function listStores(db: DbOrTx): Promise<Store[]> {
  return db.select().from(stores).orderBy(desc(stores.createdAt))
}
