/**
 * Operator CLI. Publishes every product's current state as a ProductUpdated
 * event (same version), so consumers can refill their copies of the catalog,
 * e.g. after new fields were added to the event. With the Basketline integration
 * configured (platform retailer.ts), also sends each tenant's sellers and products
 * to its reference API, e.g. for products from before the integration.
 *
 *   node src/cli.ts republish
 */
import { parseArgs } from 'node:util'
import { TOPICS } from '@basketline/contracts'
import { closeDb, createBusFromEnv, createEventPublisher, createLogger, requireEnv, retailerIntegrationFromEnv } from '@basketline/platform'
import { createProductDb, migrateProductDb } from './db/client.ts'
import { listAllProducts, listSellers } from './repositories/product.repository.ts'
import { productUpdate, stateEvent } from './services/product.service.ts'

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
  const retailer = retailerIntegrationFromEnv(logger)
  if (retailer) {
    for (const tenantId of new Set(products.map((product) => product.tenantId))) {
      const sellers = (await listSellers(db, tenantId)).map((seller) => ({
        eventName: 'seller_upserted',
        updatedAt: seller.createdAt.toISOString(),
        data: { sellerId: seller.id, name: seller.name },
      }))
      const updates = [...sellers, ...products.filter((product) => product.tenantId === tenantId).map(productUpdate)]
      // The reference API takes up to 500 updates a request.
      for (let i = 0; i < updates.length; i += BATCH) await retailer.send(tenantId, 'catalog', updates.slice(i, i + BATCH))
    }
  }
  console.log(JSON.stringify({ republished: products.length, sentToBasketline: Boolean(retailer) }))
} finally {
  await bus.close()
  await closeDb(db)
}
