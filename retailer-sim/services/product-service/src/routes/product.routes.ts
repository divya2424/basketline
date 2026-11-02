import { Router, type RequestHandler } from 'express'
import { requireRole, uuidParam, validate } from '@basketline/platform'
import type { ProductController } from '../controllers/product.controller.ts'
import { validateCreateProduct, validateListProductsQuery, validateUpdateProduct } from '../validators/product.validator.ts'

/** Mounted at /api/v1/products. */
/** Reads are public (the storefront shows the catalog to visitors); writes need a campaign manager. Both see one tenant's products. */
export function productRoutes(
  controller: ProductController,
  { authenticate, optionalAuth }: { authenticate: RequestHandler; optionalAuth: RequestHandler },
): Router {
  const router = Router()
  const manager = requireRole('campaign-manager')
  router.param('productId', uuidParam)

  router.get('/', optionalAuth, validate(validateListProductsQuery, 'query'), controller.list)
  router.get('/:productId', optionalAuth, controller.get)
  router.post('/', authenticate, manager, validate(validateCreateProduct), controller.create)
  router.patch('/:productId', authenticate, manager, validate(validateUpdateProduct), controller.update)
  router.delete('/:productId', authenticate, manager, controller.deactivate)

  return router
}
