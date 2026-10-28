import type { CryptoKey } from 'jose'
import {
  authenticate,
  createBaseApp,
  createEventPublisher,
  createHealth,
  errorHandler,
  notFoundHandler,
  optionalAuth,
  pingDb,
  type EventBus,
  type Health,
  type Logger,
} from '@shopsphere/platform'
import { createProductController } from './controllers/product.controller.ts'
import type { Db } from './db/client.ts'
import { productRoutes } from './routes/product.routes.ts'
import { createProductService } from './services/product.service.ts'

export interface ProductAppDeps {
  db: Db
  bus: EventBus
  logger: Logger
  publicKey: CryptoKey
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

/** Builds the Express app: service → controller → routes. */
export function buildProductApp({ db, bus, logger, publicKey, health = createHealth({ started: true }) }: ProductAppDeps) {
  health.addCheck('database', () => pingDb(db))
  const app = createBaseApp({ name: 'product-service', logger, health })

  const service = createProductService({ db, publish: createEventPublisher(bus, 'product-service', logger) })
  const controller = createProductController(service)

  app.use('/api/v1/products', productRoutes(controller, { authenticate: authenticate(publicKey), optionalAuth: optionalAuth(publicKey) }))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
