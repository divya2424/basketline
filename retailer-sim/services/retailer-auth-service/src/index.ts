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
import { createBasketlineClient, RETAILER_TOPICS } from '@retailer-sim/shared'
import { buildRetailerAuthApp } from './app.ts'
import { createRetailerAuthDb, migrateRetailerAuthDb } from './db/client.ts'

const logger = createLogger('retailer-auth-service')
const health = createHealth()

const db = createRetailerAuthDb(requireEnv('DATABASE_URL'), logger)
await migrateRetailerAuthDb(db)
const bus = await createBusFromEnv('retailer-auth-service', logger, [RETAILER_TOPICS.stores])
health.addCheck('kafka', () => bus.healthCheck())

const app = buildRetailerAuthApp({
  db,
  bus,
  logger,
  health,
  privateKey: await loadPrivateKey(secretEnv('JWT_PRIVATE_KEY')),
  publicKey: await loadPublicKey(secretEnv('JWT_PUBLIC_KEY')),
  basketline: createBasketlineClient({ apiUrl: requireEnv('BASKETLINE_API_URL') }),
  secretsKey: secretEnv('RETAILER_SECRETS_KEY'),
  loginRateLimit: intEnv('LOGIN_RATE_LIMIT', 10),
})
const port = intEnv('PORT', 4006)
const server = app.listen(port, () => {
  health.markStarted()
  logger.info({ port }, 'retailer-auth-service listening')
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
