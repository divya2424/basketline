import { TOPICS } from '@basketline/contracts'
import {
  closeDb,
  createBusFromEnv,
  createHealth,
  createLogger,
  handleShutdown,
  intEnv,
  loadPrivateKey,
  loadPublicKey,
  requireEnv,
  secretEnv,
} from '@basketline/platform'
import { buildAuthApp } from './app.ts'
import { createAuthDb, migrateAuthDb } from './db/client.ts'

const logger = createLogger('auth-service')
const health = createHealth()

const db = createAuthDb(requireEnv('DATABASE_URL'), logger)
await migrateAuthDb(db)
const bus = await createBusFromEnv('auth-service', logger, [TOPICS.users, TOPICS.sessions, TOPICS.tenants])
health.addCheck('kafka', () => bus.healthCheck())

const app = buildAuthApp({
  db,
  bus,
  logger,
  health,
  privateKey: await loadPrivateKey(secretEnv('JWT_PRIVATE_KEY')),
  publicKey: await loadPublicKey(secretEnv('JWT_PUBLIC_KEY')),
  loginRateLimit: intEnv('LOGIN_RATE_LIMIT', 10),
  internalSecret: process.env.INTERNAL_INTEGRATION_SECRET || undefined,
})
const port = intEnv('PORT', 4001)
const server = app.listen(port, () => {
  health.markStarted()
  logger.info({ port }, 'auth-service listening')
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
