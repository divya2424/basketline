import { TOPICS } from '@shopsphere/contracts'
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
} from '@shopsphere/platform'
import { buildCampaignApp } from './app.ts'
import { createCampaignDb, migrateCampaignDb } from './db/client.ts'
import { handleProductEvent } from './events/product.consumer.ts'
import { createTenantSeeder } from './events/tenant.consumer.ts'

const logger = createLogger('campaign-service')
const health = createHealth()

const db = createCampaignDb(requireEnv('DATABASE_URL'), logger)
await migrateCampaignDb(db)
const bus = await createBusFromEnv('campaign-service', logger, [TOPICS.campaigns, TOPICS.tenants])
health.addCheck('kafka', () => bus.healthCheck())

// One consumer for both topics (each handler ignores the other's event types):
// - product.v1 keeps the local products copy up to date. There is no inbox table:
//   events apply by product version, so a redelivered one changes nothing.
// - auth.tenant.v1 seeds each onboarded tenant's campaigns, by their planned IDs.
const seedTenant = createTenantSeeder({ db, publish: createEventPublisher(bus, 'campaign-service', logger) })
await bus.subscribe({
  groupId: 'campaign-service',
  topics: [TOPICS.products, TOPICS.tenants],
  handler: async (envelope) => {
    await handleProductEvent(db, envelope)
    await seedTenant(envelope)
  },
})

const app = buildCampaignApp({ db, bus, logger, health, publicKey: await loadPublicKey(secretEnv('JWT_PUBLIC_KEY')) })
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
