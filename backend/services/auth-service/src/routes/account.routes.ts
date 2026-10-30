import { Router } from 'express'
import { badRequest, isUuid, validate } from '@basketline/platform'
import type { AccountController } from '../controllers/account.controller.ts'
import { validateDeleteAccount, validateOnboard } from '../validators/account.validator.ts'

/**
 * Mounted at /api/v1/accounts. Public: the onboarding page uses it without
 * signing in, including deleting a tenant (by choice, for demos: see the README;
 * the tenant's name must be typed again).
 */
export function accountRoutes(controller: AccountController): Router {
  const router = Router()
  router.get('/', controller.list)
  router.post('/', validate(validateOnboard), controller.onboard)
  router.param('tenantId', (_req, _res, next, id) => (isUuid(id) ? next() : next(badRequest('INVALID_ID', 'tenantId must be a UUID'))))
  router.delete('/:tenantId', validate(validateDeleteAccount), controller.remove)
  return router
}
