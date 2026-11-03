import { and, asc, eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { placements } from '../db/schema.ts'

export type Placement = typeof placements.$inferSelect

/** The tenant's placements in order; only the active ones unless all are asked for. */
export function listPlacements(db: DbOrTx, tenantId: string, { all = false } = {}): Promise<Placement[]> {
  const where = all ? eq(placements.tenantId, tenantId) : and(eq(placements.tenantId, tenantId), eq(placements.active, true))
  return db.select().from(placements).where(where).orderBy(asc(placements.position), asc(placements.key))
}

export async function findPlacement(db: DbOrTx, tenantId: string, key: string): Promise<Placement | null> {
  const [placement] = await db.select().from(placements).where(and(eq(placements.tenantId, tenantId), eq(placements.key, key)))
  return placement ?? null
}

/** Adds the placements the tenant doesn't have yet; existing ones stay as they are. */
export async function insertPlacementsIfAbsent(db: DbOrTx, tenantId: string, list: Pick<Placement, 'key' | 'name' | 'position'>[]): Promise<void> {
  if (list.length === 0) return
  await db.insert(placements).values(list.map((placement) => ({ ...placement, tenantId }))).onConflictDoNothing()
}

/** Returns null if the tenant has no placement with that key. */
export async function updatePlacement(db: DbOrTx, tenantId: string, key: string, changes: Partial<Pick<Placement, 'name' | 'position' | 'active'>>): Promise<Placement | null> {
  const [updated] = await db
    .update(placements)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(and(eq(placements.tenantId, tenantId), eq(placements.key, key)))
    .returning()
  return updated ?? null
}
