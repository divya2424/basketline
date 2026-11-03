import { Router, type Request, type RequestHandler, type Response } from 'express'
import { badRequest, tenantHeader, validate } from '@basketline/platform'
import { requireStaff } from '@retailer-sim/shared'
import type { PlacementService } from '../services/placement.service.ts'
import { validateCreatePlacement, validateUpdatePlacement } from '../validators/placement.validator.ts'

/**
 * Mounted at /api/v1/placements. Reads are public (the storefront's sections; staff
 * may ask for inactive ones too with ?all=true); changes are the store's staff's.
 */
export function placementRoutes(service: PlacementService, { authenticate, optionalAuth }: { authenticate: RequestHandler; optionalAuth: RequestHandler }): Router {
  const router = Router()
  router.get('/', optionalAuth, async (req: Request, res: Response) => {
    const tenantId = req.retailer?.tid ?? tenantHeader(req)
    if (!tenantId) throw badRequest('TENANT_REQUIRED', 'Sign in or send a tenant_id header (UUID)')
    res.json({ items: await service.list(tenantId, { all: req.query.all === 'true' && req.retailer?.role === 'staff' }) })
  })
  router.post('/', authenticate, requireStaff, validate(validateCreatePlacement), async (req: Request, res: Response) => {
    res.status(201).json(await service.create(req.retailer!.tid, req.body))
  })
  router.patch('/:key', authenticate, requireStaff, validate(validateUpdatePlacement), async (req: Request<{ key: string }>, res: Response) => {
    res.json(await service.update(req.retailer!.tid, req.params.key, req.body))
  })
  return router
}
