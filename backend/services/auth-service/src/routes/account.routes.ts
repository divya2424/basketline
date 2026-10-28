import { Router } from 'express'
import { validate } from '@shopsphere/platform'
import type { AccountController } from '../controllers/account.controller.ts'
import { validateOnboard } from '../validators/account.validator.ts'

/** Mounted at /api/v1/accounts. Public: the onboarding page uses it without signing in. */
export function accountRoutes(controller: AccountController): Router {
  const router = Router()
  router.get('/', controller.list)
  router.post('/', validate(validateOnboard), controller.onboard)
  return router
}
