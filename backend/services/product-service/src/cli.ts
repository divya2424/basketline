/**
 * Operator CLI. Publishes every product's current state as a ProductUpdated
 * event (same version), so consumers can refill their copies of the catalog,
 * e.g. after new fields were added to the event.
 *
 *   node src/cli.ts republish
 */
import { parseArgs } from 'node:util'
import { TOPICS } from '@ecommerce-analytics/contracts'
import { closeDb, createBusFromEnv, createEventPublisher, createLogger, requireEnv } from '@ecommerce-analytics/platform'
import { createProductDb, migrateProductDb } from './db/client.ts'
import { listAllProducts } from './repositories/product.repository.ts'
import { stateEvent } from './services/product.service.ts'

const BATCH = 500

const { positionals } = parseArgs({ allowPositionals: true })
if (positionals[0] !== 'republish') throw new Error('Usage: cli.ts republish')

const logger = createLogger('product-cli')
const db = createProductDb(requireEnv('DATABASE_URL'), logger)
const bus = await createBusFromEnv('product-cli', logger, [TOPICS.products])
try {
  await migrateProductDb(db)
  const publish = createEventPublisher(bus, 'product-service', logger, { failOnError: true })
  const products = await listAllProducts(db)
  for (let i = 0; i < products.length; i += BATCH) {
    await publish(products.slice(i, i + BATCH).map((product) => stateEvent(product, 'ProductUpdated')))
  }
  console.log(JSON.stringify({ republished: products.length }))
} finally {
  await bus.close()
  await closeDb(db)
}
