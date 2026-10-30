import { TOPICS } from '@basketline/contracts'
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
import { buildProductApp } from './app.ts'
import { createProductDb, migrateProductDb } from './db/client.ts'
import { createTenantSeeder, handleTenantDeleted } from './events/tenant.consumer.ts'

const logger = createLogger('product-service')
const health = createHealth()

const db = createProductDb(requireEnv('DATABASE_URL'), logger)
await migrateProductDb(db)
const bus = await createBusFromEnv('product-service', logger, [TOPICS.products, TOPICS.tenants])
health.addCheck('kafka', () => bus.healthCheck())

// Seeds each newly onboarded tenant's catalog (TenantOnboarded from auth-service), and
// deletes a deleted tenant's (TenantDeleted).
const seedTenant = createTenantSeeder({ db, publish: createEventPublisher(bus, 'product-service', logger) })
await bus.subscribe({
  groupId: 'product-service',
  topics: [TOPICS.tenants],
  handler: async (envelope) => {
    await seedTenant(envelope)
    await handleTenantDeleted(db, envelope)
  },
})

const app = buildProductApp({ db, bus, logger, health, publicKey: await loadPublicKey(secretEnv('JWT_PUBLIC_KEY')) })
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
