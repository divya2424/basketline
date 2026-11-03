import { conflict, notFound } from '@basketline/platform'
import type { Db, DbOrTx } from '../db/client.ts'
import { findPlacement, insertPlacementsIfAbsent, listPlacements, updatePlacement, type Placement } from '../repositories/placement.repository.ts'
import type { CreatePlacementInput, UpdatePlacementInput } from '../validators/placement.validator.ts'

/** What a newly connected store's marketplace starts with: the storefront's sections, in order. */
export const DEFAULT_PLACEMENTS = [
  { key: 'spotlight', name: 'Spotlight', position: 1 },
  { key: 'top_rated', name: 'Top rated', position: 2 },
  { key: 'customer_picks', name: 'Customer picks', position: 3 },
  { key: 'deals', name: 'Deals', position: 4 },
]

/** The tenant's placement for a campaign, or null if it has none by that key or it is inactive. */
export async function activePlacement(db: DbOrTx, tenantId: string, key: string): Promise<Placement | null> {
  const placement = await findPlacement(db, tenantId, key)
  return placement?.active ? placement : null
}

/** The marketplace's placements: the storefront's campaign sections. Staff add, rename, reorder and turn them off. */
export function createPlacementService({ db }: { db: Db }) {
  return {
    list: (tenantId: string, { all = false } = {}) => listPlacements(db, tenantId, { all }),

    async create(tenantId: string, input: CreatePlacementInput): Promise<Placement> {
      if (await findPlacement(db, tenantId, input.key)) throw conflict('PLACEMENT_EXISTS', `A placement "${input.key}" already exists`)
      await insertPlacementsIfAbsent(db, tenantId, [{ key: input.key, name: input.name.trim(), position: input.position }])
      return (await findPlacement(db, tenantId, input.key))!
    },

    async update(tenantId: string, key: string, input: UpdatePlacementInput): Promise<Placement> {
      const updated = await updatePlacement(db, tenantId, key, { name: input.name?.trim(), position: input.position, active: input.active })
      if (!updated) throw notFound('PLACEMENT_NOT_FOUND', 'Placement not found')
      return updated
    },
  }
}

export type PlacementService = ReturnType<typeof createPlacementService>
