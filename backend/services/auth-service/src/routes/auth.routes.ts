import { Router, type RequestHandler } from 'express'
import { requireRole, validate } from '@basketline/platform'
import type { AuthController } from '../controllers/auth.controller.ts'
import { validateAllowedOrigins, validateApiKey, validateLogin, validateRegister, validateShopperToken, validateVisitor } from '../validators/auth.validator.ts'

/** Mounted at /api/v1/auth. */
export function authRoutes(
  controller: AuthController,
  { authenticate, loginLimiter }: { authenticate: RequestHandler; loginLimiter: RequestHandler },
): Router {
  const router = Router()

  router.post('/register', validate(validateRegister), controller.register)
  router.post('/login', validate(validateLogin), loginLimiter, controller.login)
  router.post('/visitor', validate(validateVisitor), controller.visitor)
  // A vendor's backend, with its API key: a token for its signed-in customer.
  router.post('/shopper-token', validate(validateShopperToken), controller.shopperToken)
  router.post('/logout', authenticate, controller.logout)
  router.get('/me', authenticate, controller.me)
  router.get('/sessions', authenticate, controller.sessions)
  // The tenant's API keys, for its campaign managers (the tenant is the token's).
  const manager = [authenticate, requireRole('campaign-manager')]
  router.get('/api-keys', ...manager, controller.listApiKeys)
  router.post('/api-keys', ...manager, validate(validateApiKey), controller.createApiKey)
  router.delete('/api-keys/:prefix', ...manager, controller.revokeApiKey)
  // The websites whose pages may send the tenant's events (the gateway enforces them).
  router.get('/allowed-origins', ...manager, controller.allowedOrigins)
  router.put('/allowed-origins', ...manager, validate(validateAllowedOrigins), controller.setAllowedOrigins)

  return router
}
