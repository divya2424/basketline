import type { CryptoKey } from 'jose'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import {
  authenticate,
  createBaseApp,
  createEventPublisher,
  createHealth,
  errorHandler,
  isUuid,
  notFoundHandler,
  pingDb,
  unauthorized,
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
import { createShopperService } from './services/shopper.service.ts'
import { PRODUCER } from './services/user-admin.service.ts'

export interface AuthAppDeps {
  db: Db
  bus: EventBus
  logger: Logger
  privateKey: CryptoKey
  publicKey: CryptoKey
  /** Max login attempts per IP+username per 15 minutes. */
  loginRateLimit?: number
  /** Shared with the mimic retailer services (INTERNAL_INTEGRATION_SECRET); unset: /internal/integration-token is off. */
  internalSecret?: string
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
  internalSecret,
  health = createHealth({ started: true }),
}: AuthAppDeps) {
  health.addCheck('database', () => pingDb(db))
  const app = createBaseApp({ name: 'auth-service', logger, health })

  const publish = createEventPublisher(bus, PRODUCER, logger)
  const service = createAuthService({ db, privateKey, publicKey, publish })
  const accounts = createAccountService({ db, publish })
  const shoppers = createShopperService({ db, privateKey, bus, logger })
  const controller = createAuthController(service, shoppers, accounts)

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
  app.use('/api/v1/accounts', accountRoutes(createAccountController(accounts)))
  // The mimic retailer services' integration tokens (shopper.service.ts): outside /api,
  // so the gateway never routes it, and only with the cluster's shared secret.
  if (internalSecret) {
    app.post('/internal/integration-token', async (req, res) => {
      if (req.headers['x-internal-secret'] !== internalSecret || !isUuid(req.body?.tenantId)) throw unauthorized('UNAUTHORIZED', 'Internal callers only')
      const { token } = await shoppers.internalIntegrationToken(req.body.tenantId)
      res.status(201).json({ integrationToken: token })
    })
  }
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
