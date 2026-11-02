import { Router, type RequestHandler } from 'express'
import { validate } from '@basketline/platform'
import type { RetailerController } from '../controllers/retailer.controller.ts'
import { validateConnect, validateLogin, validateShopperToken } from '../validators/retailer.validator.ts'

/**
 * Mounted at /api/v1. The stores, open to anyone like Basketline's demo
 * onboarding; sign-in for a store (its tenant_id header); and fresh shopper
 * tokens for a signed-in customer.
 */
export function retailerRoutes(controller: RetailerController, { authenticate, loginLimiter }: { authenticate: RequestHandler; loginLimiter: RequestHandler }): Router {
  const router = Router()
  router.get('/stores', controller.listStores)
  router.post('/stores', validate(validateConnect), controller.connect)
  router.post('/auth/login', validate(validateLogin), loginLimiter, controller.login)
  router.post('/auth/shopper-token', authenticate, validate(validateShopperToken), controller.shopperToken)
  return router
}
