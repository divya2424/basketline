import { TOPICS } from '@shopsphere/contracts'
import {
  closeDb,
  createBusFromEnv,
  createHealth,
  createLogger,
  handleShutdown,
  idempotentHandler,
  intEnv,
  listEnv,
  loadPublicKey,
  requireEnv,
  secretEnv,
} from '@shopsphere/platform'
import { buildGateway } from './app.ts'
import { createGatewayDb, migrateGatewayDb } from './db/client.ts'
import { handleAccessEvent } from './events/access.consumer.ts'

const logger = createLogger('gateway')
const health = createHealth()

const db = createGatewayDb(requireEnv('DATABASE_URL'), logger)
await migrateGatewayDb(db)
const bus = await createBusFromEnv('gateway', logger)
health.addCheck('kafka', () => bus.healthCheck())

// Session revocations, disabled accounts and role changes arrive as events.
await bus.subscribe({ groupId: 'gateway', topics: [TOPICS.sessions, TOPICS.users], handler: idempotentHandler(db, handleAccessEvent) })

const { app, access } = buildGateway({
  db,
  logger,
  health,
  publicKey: await loadPublicKey(secretEnv('JWT_PUBLIC_KEY')),
  services: {
    auth: requireEnv('AUTH_SERVICE_URL'),
    product: requireEnv('PRODUCT_SERVICE_URL'),
    campaign: requireEnv('CAMPAIGN_SERVICE_URL'),
    analytics: requireEnv('ANALYTICS_SERVICE_URL'),
  },
  corsOrigins: listEnv('CORS_ORIGINS', ['http://localhost:5173']),
  rateLimitPerMinute: intEnv('RATE_LIMIT_PER_MINUTE', 300),
  eventsRateLimitPerMinute: intEnv('EVENTS_RATE_LIMIT_PER_MINUTE', 120),
  visitorRateLimitPerMinute: intEnv('VISITOR_RATE_LIMIT_PER_MINUTE', 10),
})
const cleanup = setInterval(() => void access.cleanup().catch((error) => logger.error({ err: error }, 'cleanup failed')), 5 * 60_000)

const port = intEnv('PORT', 8080)
const server = app.listen(port, () => {
  health.markStarted()
  logger.info({ port }, 'gateway listening')
})

handleShutdown({
  logger,
  server,
  health,
  closers: [
    { name: 'revocation cleanup timer', close: () => clearInterval(cleanup) },
    { name: 'kafka', close: () => bus.close() },
    { name: 'database', close: () => closeDb(db) },
  ],
})
