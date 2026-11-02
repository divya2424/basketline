/**
 * Operator CLI. Publishes every product's current state as a ProductUpdated
 * event (same version), so consumers can refill their copies of the catalog,
 * e.g. after new fields were added to the event. Also sends each connected
 * store's sellers and products to Basketline with its API key, e.g. after
 * Basketline lost them.
 *
 *   node src/cli.ts republish
 */
import { parseArgs } from 'node:util'
import { closeDb, createBusFromEnv, createEventPublisher, createLogger, requireEnv, secretEnv } from '@basketline/platform'
import { createBasketlineSender, openSecret, RETAILER_EVENTS, RETAILER_TOPICS } from '@retailer-sim/shared'
import { createProductDb, migrateProductDb } from './db/client.ts'
import { listAllProducts, listSellers } from './repositories/product.repository.ts'
import { findSealedApiKey } from './repositories/store.repository.ts'
import { basketlineProduct, stateEvent } from './services/product.service.ts'

const BATCH = 500

const { positionals } = parseArgs({ allowPositionals: true })
if (positionals[0] !== 'republish') throw new Error('Usage: cli.ts republish')

const logger = createLogger('product-cli')
const db = createProductDb(requireEnv('DATABASE_URL'), logger)
const bus = await createBusFromEnv('product-cli', logger, [RETAILER_TOPICS.products])
try {
  await migrateProductDb(db)
  const publish = createEventPublisher(bus, 'product-service', logger, { failOnError: true, registry: RETAILER_EVENTS })
  const products = await listAllProducts(db)
  for (let i = 0; i < products.length; i += BATCH) {
    await publish(products.slice(i, i + BATCH).map((product) => stateEvent(product, 'ProductUpdated')))
  }
  const secretsKey = secretEnv('RETAILER_SECRETS_KEY')
  const basketline = createBasketlineSender({
    apiUrl: requireEnv('BASKETLINE_API_URL'),
    apiKeyFor: async (tenantId) => {
      const sealed = await findSealedApiKey(db, tenantId)
      return sealed ? openSecret(sealed, secretsKey) : null
    },
    logger,
  })
  for (const tenantId of new Set(products.map((product) => product.tenantId))) {
    const sellers = (await listSellers(db, tenantId)).map(({ id: sellerId, name, createdAt: updatedAt }) => ({ sellerId, name, updatedAt }))
    const tenantProducts = products.filter((product) => product.tenantId === tenantId).map(basketlineProduct)
    // The retail API takes up to 500 updates a request.
    await basketline.send(tenantId, async (server) => {
      if (sellers.length > 0) await server.catalog.upsertSeller(sellers)
      for (let i = 0; i < tenantProducts.length; i += BATCH) await server.catalog.upsertProduct(tenantProducts.slice(i, i + BATCH))
    })
  }
  console.log(JSON.stringify({ republished: products.length }))
} finally {
  await bus.close()
  await closeDb(db)
}
