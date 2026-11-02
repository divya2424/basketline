import type { CryptoKey } from 'jose'
import { createBaseApp, createEventPublisher, createHealth, errorHandler, notFoundHandler, pingDb, type EventBus, type Health, type Logger } from '@basketline/platform'
import { RETAILER_EVENTS, retailerAuth, type BasketlineSender } from '@retailer-sim/shared'
import { createProductController } from './controllers/product.controller.ts'
import type { Db } from './db/client.ts'
import { productRoutes } from './routes/product.routes.ts'
import { createProductService } from './services/product.service.ts'

export interface ProductAppDeps {
  db: Db
  bus: EventBus
  logger: Logger
  /** The retailer's token key (retailer-auth-service signs with it). */
  publicKey: CryptoKey
  /** Sends each product's state to Basketline with the store's API key; none in tests. */
  basketline?: BasketlineSender
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

/** Builds the Express app: service → controller → routes. */
export function buildProductApp({ db, bus, logger, publicKey, basketline, health = createHealth({ started: true }) }: ProductAppDeps) {
  health.addCheck('database', () => pingDb(db))
  const app = createBaseApp({ name: 'product-service', logger, health })

  const service = createProductService({ db, publish: createEventPublisher(bus, 'product-service', logger, { registry: RETAILER_EVENTS }), basketline })
  const controller = createProductController(service)

  const optionalAuth = retailerAuth(publicKey, { optional: true })
  app.use('/api/v1/products', productRoutes(controller, { authenticate: retailerAuth(publicKey), optionalAuth }))
  // The tenant's sellers, to pick one for a product or campaign (public, like the catalog).
  app.get('/api/v1/sellers', optionalAuth, controller.sellers)
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
