import { Router, type RequestHandler } from 'express'
import { validate } from '@basketline/platform'
import type { AuthController } from '../controllers/auth.controller.ts'
import { validateLogin, validateRegister, validateVisitor } from '../validators/auth.validator.ts'

/** Mounted at /api/v1/auth. */
export function authRoutes(
  controller: AuthController,
  { authenticate, loginLimiter }: { authenticate: RequestHandler; loginLimiter: RequestHandler },
): Router {
  const router = Router()

  router.post('/register', validate(validateRegister), controller.register)
  router.post('/login', validate(validateLogin), loginLimiter, controller.login)
  router.post('/visitor', validate(validateVisitor), controller.visitor)
  router.post('/logout', authenticate, controller.logout)
  router.get('/me', authenticate, controller.me)
  router.get('/sessions', authenticate, controller.sessions)

  return router
}
