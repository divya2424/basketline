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
import { buildCampaignApp } from './app.ts'
import { createCampaignDb, migrateCampaignDb } from './db/client.ts'
import { handleProductEvent } from './events/product.consumer.ts'
import { createStoreConnector } from './events/store.consumer.ts'
import { findSealedApiKey } from './repositories/store.repository.ts'

const logger = createLogger('campaign-service')
const health = createHealth()

const db = createCampaignDb(requireEnv('DATABASE_URL'), logger)
await migrateCampaignDb(db)
const bus = await createBusFromEnv('campaign-service', logger, [RETAILER_TOPICS.campaigns, RETAILER_TOPICS.stores])
health.addCheck('kafka', () => bus.healthCheck())

// As each store's backend: its campaigns go to Basketline with its API key.
const secretsKey = secretEnv('RETAILER_SECRETS_KEY')
const basketline = createBasketlineSender({
  apiUrl: requireEnv('BASKETLINE_API_URL'),
  apiKeyFor: async (tenantId) => {
    const sealed = await findSealedApiKey(db, tenantId)
    return sealed ? openSecret(sealed, secretsKey) : null
  },
  logger,
})
// One consumer for both topics (each handler ignores the other's event types):
// - product.v1 keeps the local products copy up to date. There is no inbox table:
//   events apply by product version, so a redelivered one changes nothing (but
//   its campaign products go to Basketline again, harmlessly: newest wins).
// - retailer.store.v1 seeds each newly connected store's campaigns, by their planned IDs.
const connectStore = createStoreConnector({ db, publish: createEventPublisher(bus, 'campaign-service', logger, { registry: RETAILER_EVENTS }), basketline })
await bus.subscribe({
  groupId: 'campaign-service',
  topics: [RETAILER_TOPICS.products, RETAILER_TOPICS.stores],
  handler: async (envelope) => {
    await handleProductEvent(db, envelope, basketline)
    await connectStore(envelope)
  },
})

const app = buildCampaignApp({ db, bus, logger, health, basketline, publicKey: await loadPublicKey(secretEnv('JWT_PUBLIC_KEY')) })
const port = intEnv('PORT', 4003)
const server = app.listen(port, () => {
  health.markStarted()
  logger.info({ port }, 'campaign-service listening')
})

handleShutdown({
  logger,
  server,
  health,
  closers: [
    // Stops the consumer (its current message finishes first) and the producer.
    { name: 'kafka', close: () => bus.close() },
    { name: 'database', close: () => closeDb(db) },
  ],
})
