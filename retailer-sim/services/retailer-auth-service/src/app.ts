import type { CryptoKey } from 'jose'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { createBaseApp, createEventPublisher, createHealth, errorHandler, notFoundHandler, pingDb, type EventBus, type Health, type Logger } from '@basketline/platform'
import { RETAILER_EVENTS, retailerAuth, type BasketlineClient } from '@retailer-sim/shared'
import { createRetailerController } from './controllers/retailer.controller.ts'
import type { Db } from './db/client.ts'
import { retailerRoutes } from './routes/retailer.routes.ts'
import { createAuthService } from './services/auth.service.ts'
import { createStoreService } from './services/store.service.ts'

export interface RetailerAuthAppDeps {
  db: Db
  bus: EventBus
  logger: Logger
  privateKey: CryptoKey
  publicKey: CryptoKey
  /** Basketline's public API (onboarding, shopper tokens). */
  basketline: BasketlineClient
  /** Seals the stores' Basketline API keys (RETAILER_SECRETS_KEY). */
  secretsKey: string
  /** Max login attempts per IP+store+username per 15 minutes. */
  loginRateLimit?: number
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

/** Builds the Express app: service → controller → routes. */
export function buildRetailerAuthApp({ db, bus, logger, privateKey, publicKey, basketline, secretsKey, loginRateLimit = 10, health = createHealth({ started: true }) }: RetailerAuthAppDeps) {
  health.addCheck('database', () => pingDb(db))
  const app = createBaseApp({ name: 'retailer-auth-service', logger, health })

  const publish = createEventPublisher(bus, 'retailer-auth-service', logger, { registry: RETAILER_EVENTS })
  const stores = createStoreService({ db, publish, basketline, secretsKey })
  const auth = createAuthService({ db, privateKey, basketline, secretsKey, logger })
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: loginRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? 'unknown')}:${String(req.headers.tenant_id)}:${String(req.body?.username ?? '').toLowerCase()}`,
    handler: (req, res) => {
      res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many sign-in attempts; try again later', requestId: req.id } })
    },
  })

  app.use('/api/v1', retailerRoutes(createRetailerController(stores, auth), { authenticate: retailerAuth(publicKey), loginLimiter }))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
