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
  type RetailerIntegration
} from '@basketline/platform'
import { createProductController } from './controllers/product.controller.ts'
import type { Db } from './db/client.ts'
import { productRoutes } from './routes/product.routes.ts'
import { createProductService } from './services/product.service.ts'

export interface ProductAppDeps {
  db: Db
  bus: EventBus
  logger: Logger
  publicKey: CryptoKey
  /** Sends each product's state to Basketline (platform retailer.ts); none in tests. */
  retailer?: RetailerIntegration
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

/** Builds the Express app: service → controller → routes. */
export function buildProductApp({ db, bus, logger, publicKey, retailer, health = createHealth({ started: true }) }: ProductAppDeps) {
  health.addCheck('database', () => pingDb(db))
  const app = createBaseApp({ name: 'product-service', logger, health })

  const service = createProductService({ db, publish: createEventPublisher(bus, 'product-service', logger), retailer })
  const controller = createProductController(service)

  app.use('/api/v1/products', productRoutes(controller, { authenticate: authenticate(publicKey), optionalAuth: optionalAuth(publicKey) }))
  // The tenant's sellers, to pick one for a product or campaign (public, like the catalog).
  app.get('/api/v1/sellers', optionalAuth(publicKey), controller.sellers)
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
