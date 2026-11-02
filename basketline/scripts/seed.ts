/**
 * Loads the storefront's sample catalog (retailer-sim/storefront/src/features/*\/…Data.js)
 * into the running backend through the gateway, as a campaign manager. Products
 * and campaigns belong to that manager's tenant (SEED_TENANT, default: the
 * storefront's default tenant).
 * Safe to run repeatedly: existing products (same name) are updated to match
 * the sample data; existing campaigns (same title) are left as they are.
 * New products go to the tenant's first seller (GET /sellers): sellers come
 * with onboarding (POST /accounts, or the auth CLI's seed-tenant). A campaign is
 * its first product's seller's, with only that seller's products.
 *
 *   SEED_USERNAME=maya SEED_PASSWORD='correct horse battery' SEED_TENANT=5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01 pnpm seed
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { campaigns as sampleCampaigns } from '../../retailer-sim/storefront/src/features/campaigns/campaignData.js'
import { products as sampleProducts } from '../../retailer-sim/storefront/src/features/products/productData.js'

const API = process.env.API_URL ?? 'http://localhost:8080/api/v1'
const username = process.env.SEED_USERNAME ?? 'maya'
const password = process.env.SEED_PASSWORD ?? 'correct horse battery'
// Usernames are per tenant, so login names the tenant (the storefront's tenant_id header).
const tenant = process.env.SEED_TENANT ?? '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01'

let token = ''
// `any`: this script only reads a few documented response fields.
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', tenant_id: tenant, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = res.status === 204 ? null : await res.json()
  return { status: res.status, json }
}

const login = await api('POST', '/auth/login', { username, password, clientType: 'web' })
if (login.status !== 200) throw new Error(`Login as ${username} failed (${login.status}). Create a campaign manager with the auth-service CLI first.`)
token = login.json.accessToken

// The tenant's first seller (by name) publishes the products and runs the campaigns.
const sellers = (await api('GET', '/sellers')).json.sellers as { sellerId: string; name: string }[]
if (sellers.length === 0) throw new Error(`Tenant ${tenant} has no sellers: onboard it (POST /accounts) or run the auth CLI's seed-tenant first.`)
const sellerId = sellers[0]!.sellerId

// Products, matched by name.
type ApiProduct = { id: string; sellerId: string; name: string; description: string; price: number; image: string | null; category: string | null; isActive: boolean }
const existingProducts = (await api('GET', '/products?limit=100&includeInactive=true')).json.items as ApiProduct[]
const productByName = new Map(existingProducts.map((p) => [p.name, p]))
const backendIdBySampleId = new Map<string, string>()
const sellerOfProduct = new Map<string, string>()
for (const sample of sampleProducts) {
  const fields = { name: sample.name, description: sample.description, price: sample.price, image: sample.image, category: sample.category }
  const existing = productByName.get(sample.name)
  if (!existing) {
    const created = await api('POST', '/products', { sellerId, ...fields })
    if (created.status !== 201) throw new Error(`Creating ${sample.name} failed: ${JSON.stringify(created.json)}`)
    backendIdBySampleId.set(sample.id, created.json.id)
    sellerOfProduct.set(created.json.id, sellerId)
    console.log(`created product  ${sample.name}`)
    continue
  }
  const outdated = (Object.keys(fields) as (keyof typeof fields)[]).some((key) => existing[key] !== fields[key]) || !existing.isActive
  if (outdated) {
    const updated = await api('PATCH', `/products/${existing.id}`, { ...fields, ...(existing.isActive ? {} : { isActive: true }) })
    if (updated.status !== 200) throw new Error(`Updating ${sample.name} failed: ${JSON.stringify(updated.json)}`)
    console.log(`updated product  ${sample.name}`)
  }
  backendIdBySampleId.set(sample.id, existing.id)
  sellerOfProduct.set(existing.id, existing.sellerId)
}

// Campaigns, matched by title. The campaign service learns about new products
// over Kafka, so retry while it answers PRODUCT_NOT_YET_AVAILABLE.
const existingCampaigns = (await api('GET', '/campaigns?limit=100&includeArchived=true')).json.items as { title: string }[]
const existingTitles = new Set(existingCampaigns.map((c) => c.title))
for (const sample of sampleCampaigns) {
  if (existingTitles.has(sample.title)) continue
  const productIds = sample.productIds.map((id: string) => backendIdBySampleId.get(id)!)
  const campaignSeller = sellerOfProduct.get(productIds[0]!) ?? sellerId
  const own = productIds.filter((id) => sellerOfProduct.get(id) === campaignSeller)
  if (own.length < productIds.length) console.log(`campaign ${sample.title}: left out ${productIds.length - own.length} products of other sellers`)
  const body = {
    sellerId: campaignSeller,
    title: sample.title,
    type: sample.type,
    description: sample.description ?? null,
    status: 'active',
    productIds: own,
  }
  for (let attempt = 1; ; attempt += 1) {
    const created = await api('POST', '/campaigns', body)
    if (created.status === 201) {
      console.log(`created campaign ${sample.title}`)
      break
    }
    if (created.json?.error?.code !== 'PRODUCT_NOT_YET_AVAILABLE' || attempt === 30) {
      throw new Error(`Creating ${sample.title} failed: ${JSON.stringify(created.json)}`)
    }
    await sleep(1000)
  }
}

await api('POST', '/auth/logout')
console.log(`Seeded ${sampleProducts.length} products and ${sampleCampaigns.length} campaigns at ${API}.`)
