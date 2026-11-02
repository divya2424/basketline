import type { Request, Response } from 'express'
import { badRequest, tenantHeader } from '@basketline/platform'
import type { Store } from '../repositories/store.repository.ts'
import type { AuthService } from '../services/auth.service.ts'
import type { StoreService } from '../services/store.service.ts'

/** Dates become ISO strings in res.json; never the API key. */
const toPublicStore = ({ tenantId, name, tier, createdAt }: Store) => ({ tenantId, name, tier, createdAt })

function requireTenant(req: Request): string {
  const tenantId = tenantHeader(req)
  if (!tenantId) throw badRequest('TENANT_REQUIRED', 'Send the store as a tenant_id header (UUID)')
  return tenantId
}

export function createRetailerController(stores: StoreService, auth: AuthService) {
  return {
    async listStores(_req: Request, res: Response) {
      res.json({ items: (await stores.list()).map(toPublicStore) })
    },

    async connect(req: Request, res: Response) {
      const { store, ...rest } = await stores.connect(req.body)
      res.status(201).json({ store: toPublicStore(store), ...rest })
    },

    async login(req: Request, res: Response) {
      res.json(await auth.login(requireTenant(req), req.body))
    },

    async shopperToken(req: Request, res: Response) {
      res.status(201).json(await auth.shopperToken(req.retailer!, req.body ?? {}))
    },
  }
}

export type RetailerController = ReturnType<typeof createRetailerController>
