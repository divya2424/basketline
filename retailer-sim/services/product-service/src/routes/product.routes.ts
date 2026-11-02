import { Router, type RequestHandler } from 'express'
import { uuidParam, validate } from '@basketline/platform'
import { requireStaff } from '@retailer-sim/shared'
import type { ProductController } from '../controllers/product.controller.ts'
import { validateCreateProduct, validateListProductsQuery, validateUpdateProduct } from '../validators/product.validator.ts'

/** Mounted at /api/v1/products. */
/** Reads are public (the storefront shows the catalog to visitors); writes need the store's staff. Both see one tenant's products. */
export function productRoutes(
  controller: ProductController,
  { authenticate, optionalAuth }: { authenticate: RequestHandler; optionalAuth: RequestHandler },
): Router {
  const router = Router()
  router.param('productId', uuidParam)

  router.get('/', optionalAuth, validate(validateListProductsQuery, 'query'), controller.list)
  router.get('/:productId', optionalAuth, controller.get)
  router.post('/', authenticate, requireStaff, validate(validateCreateProduct), controller.create)
  router.patch('/:productId', authenticate, requireStaff, validate(validateUpdateProduct), controller.update)
  router.delete('/:productId', authenticate, requireStaff, controller.deactivate)

  return router
}
