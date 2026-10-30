import type { CryptoKey } from 'jose'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import {
  authenticate,
  createBaseApp,
  createEventPublisher,
  createHealth,
  errorHandler,
  notFoundHandler,
  pingDb,
  type EventBus,
  type Health,
  type Logger,
} from '@basketline/platform'
import type { Db } from './db/client.ts'
import { createAccountController } from './controllers/account.controller.ts'
import { createAuthController } from './controllers/auth.controller.ts'
import { accountRoutes } from './routes/account.routes.ts'
import { authRoutes } from './routes/auth.routes.ts'
import { createAccountService } from './services/account.service.ts'
import { createAuthService } from './services/auth.service.ts'
import { PRODUCER } from './services/user-admin.service.ts'

export interface AuthAppDeps {
  db: Db
  bus: EventBus
  logger: Logger
  privateKey: CryptoKey
  publicKey: CryptoKey
  /** Max login attempts per IP+username per 15 minutes. */
  loginRateLimit?: number
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

/** Builds the Express app: service → controller → routes. */
export function buildAuthApp({
  db,
  bus,
  logger,
  privateKey,
  publicKey,
  loginRateLimit = 10,
  health = createHealth({ started: true }),
}: AuthAppDeps) {
  health.addCheck('database', () => pingDb(db))
  const app = createBaseApp({ name: 'auth-service', logger, health })

  const publish = createEventPublisher(bus, PRODUCER, logger)
  const service = createAuthService({ db, privateKey, publicKey, publish })
  const controller = createAuthController(service)

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: loginRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Usernames are per tenant, so the tenant is part of the key.
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? 'unknown')}:${String(req.headers.tenant_id)}:${String(req.body?.username ?? '').toLowerCase()}`,
    handler: (req, res) => {
      req.log.warn({ username: req.body?.username }, 'login rate limit exceeded')
      res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many sign-in attempts; try again later', requestId: req.id } })
    },
  })

  // This service owns the session table, so its routes also reject ended sessions directly.
  app.use('/api/v1/auth', authRoutes(controller, { authenticate: authenticate(publicKey, service.checkSession), loginLimiter }))
  app.use('/api/v1/accounts', accountRoutes(createAccountController(createAccountService({ db, publish }))))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
