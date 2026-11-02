import {
  closeDb,
  createBusFromEnv,
  createEventPublisher,
  createHealth,
  createLogger,
  handleShutdown,
  intEnv,
  loadPublicKey,
  requireEnv,
  secretEnv,
} from '@basketline/platform'
import { createBasketlineSender, openSecret, RETAILER_EVENTS, RETAILER_TOPICS } from '@retailer-sim/shared'
import { buildProductApp } from './app.ts'
import { createProductDb, migrateProductDb } from './db/client.ts'
import { createStoreConnector } from './events/store.consumer.ts'
import { findSealedApiKey } from './repositories/store.repository.ts'

const logger = createLogger('product-service')
const health = createHealth()

const db = createProductDb(requireEnv('DATABASE_URL'), logger)
await migrateProductDb(db)
const bus = await createBusFromEnv('product-service', logger, [RETAILER_TOPICS.products, RETAILER_TOPICS.stores])
health.addCheck('kafka', () => bus.healthCheck())

// As each store's backend: its products go to Basketline with its API key.
const secretsKey = secretEnv('RETAILER_SECRETS_KEY')
const basketline = createBasketlineSender({
  apiUrl: requireEnv('BASKETLINE_API_URL'),
  apiKeyFor: async (tenantId) => {
    const sealed = await findSealedApiKey(db, tenantId)
    return sealed ? openSecret(sealed, secretsKey) : null
  },
  logger,
})
// Seeds each newly connected store's catalog (StoreConnected, from retailer-auth-service).
const connectStore = createStoreConnector({ db, publish: createEventPublisher(bus, 'product-service', logger, { registry: RETAILER_EVENTS }), basketline })
await bus.subscribe({ groupId: 'product-service', topics: [RETAILER_TOPICS.stores], handler: connectStore })

const app = buildProductApp({ db, bus, logger, health, basketline, publicKey: await loadPublicKey(secretEnv('JWT_PUBLIC_KEY')) })
const port = intEnv('PORT', 4002)
const server = app.listen(port, () => {
  health.markStarted()
  logger.info({ port }, 'product-service listening')
})

handleShutdown({
  logger,
  server,
  health,
  closers: [
    { name: 'kafka', close: () => bus.close() },
    { name: 'database', close: () => closeDb(db) },
  ],
})
