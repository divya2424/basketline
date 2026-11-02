/**
 * Sends the storefront's sample catalog (retailer-sim/storefront/src/features/*\/…Data.js)
 * to a tenant through Basketline's retail API, as a store's backend does:
 * the tenant's API key buys an integration token (POST /auth/integration-token),
 * which sends one seller, the products, the campaigns (all active, in the "web"
 * store) and each campaign's products, with the sample IDs as the store's own
 * (product_001, campaign_001, …). For a tenant
 * without the simulated retailer, e.g. the load test's. Safe to run repeatedly:
 * every record is an upsert.
 *
 *   SEED_TENANT=<uuid> SEED_API_KEY=bl_sk_… pnpm seed
 */
import { campaigns as sampleCampaigns } from '../../retailer-sim/storefront/src/features/campaigns/campaignData.js'
import { products as sampleProducts } from '../../retailer-sim/storefront/src/features/products/productData.js'

const API = process.env.API_URL ?? 'http://localhost:8080/api/v1'
const tenant = process.env.SEED_TENANT ?? '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01'
const apiKey = process.env.SEED_API_KEY
if (!apiKey) throw new Error('SEED_API_KEY is required: create one with the auth CLI (create-api-key) or on the dashboard.')
const SELLER_ID = 'sample-seller'
const STORE_ID = 'web'

// `any`: this script only reads a few documented response fields.
async function post(path: string, authorization: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', tenant_id: tenant, authorization },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${JSON.stringify(json)}`)
  return json
}

const { integrationToken } = await post('/auth/integration-token', `ApiKey ${apiKey}`)
const bearer = `Bearer ${integrationToken}`

await post('/retail/catalog', bearer, {
  events: [
    { eventName: 'seller_upserted', data: { sellerId: SELLER_ID, name: 'Sample seller' } },
    ...sampleProducts.map((product) => ({
      eventName: 'product_upserted',
      data: { productId: product.id, storeId: STORE_ID, sellerId: SELLER_ID, name: product.name, category: product.category, price: product.price, isActive: true },
    })),
  ],
})
await post('/retail/campaigns', bearer, {
  events: sampleCampaigns.flatMap((campaign) => [
    {
      eventName: 'campaign_upserted',
      data: { campaignId: campaign.id, storeId: STORE_ID, sellerId: SELLER_ID, title: campaign.title, status: 'active', productIds: campaign.productIds },
    },
    ...campaign.productIds.map((productId) => {
      const product = sampleProducts.find(({ id }) => id === productId)!
      return {
        eventName: 'campaign_product_added',
        data: { campaignId: campaign.id, productId, storeId: STORE_ID, sellerId: SELLER_ID, productName: product.name, productPrice: product.price, category: product.category },
      }
    }),
  ]),
})

console.log(`Sent ${sampleProducts.length} products and ${sampleCampaigns.length} campaigns with their products to tenant ${tenant} at ${API}.`)
