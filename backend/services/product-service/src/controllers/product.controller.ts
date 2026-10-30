import type { Request, Response } from 'express'
import { badRequest, page, readPagination, tenantHeader } from '@basketline/platform'
import type { Product } from '../repositories/product.repository.ts'
import type { ProductService } from '../services/product.service.ts'

/** API representation: every column except the internal version. Dates become ISO strings in res.json. */
function toProductResponse({ version: _version, ...product }: Product) {
  return product
}

/**
 * The tenant whose catalog a read sees: the signed-in user's (from the token),
 * else the storefront's tenant_id header for anonymous visitors.
 */
function readTenant(req: Request): string {
  const tenantId = req.auth?.tid ?? tenantHeader(req)
  if (!tenantId) throw badRequest('TENANT_REQUIRED', 'Sign in or send a tenant_id header (UUID)')
  return tenantId
}

/** :productId has already been checked to be a UUID by router.param in the routes file. */
type WithProductId = Request<{ productId: string }>

export function createProductController(service: ProductService) {
  return {
    async create(req: Request, res: Response) {
      const product = await service.create(req.auth!.tid, req.auth!.sub, req.body)
      res.status(201).location(`/api/v1/products/${product.id}`).json(toProductResponse(product))
    },

    async list(req: Request, res: Response) {
      const { limit, offset } = readPagination(req.query)
      const { items, total } = await service.list({
        tenantId: readTenant(req),
        category: typeof req.query.category === 'string' ? req.query.category : undefined,
        // Only campaign managers can see deactivated products.
        includeInactive: req.query.includeInactive === 'true' && req.auth?.role === 'campaign-manager',
        limit,
        offset,
      })
      res.json(page(items.map(toProductResponse), total, limit, offset))
    },

    async get(req: WithProductId, res: Response) {
      res.json(toProductResponse(await service.get(readTenant(req), req.params.productId)))
    },

    async update(req: WithProductId, res: Response) {
      res.json(toProductResponse(await service.update(req.auth!.tid, req.auth!.sub, req.params.productId, req.body)))
    },

    async deactivate(req: WithProductId, res: Response) {
      res.json(toProductResponse(await service.deactivate(req.auth!.tid, req.auth!.sub, req.params.productId)))
    },
  }
}

export type ProductController = ReturnType<typeof createProductController>
