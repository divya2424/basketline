/**
 * The demo catalog a newly connected store is seeded with: 10–15 products from
 * two sellers, and active campaigns of 2 and 3 of them. The plan is drawn from a
 * random key, before the store is onboarded; StoreConnected carries the plan itself, so applying it again
 * creates nothing twice.
 */
import { createHash } from 'node:crypto'

export interface SeedPlan {
  productIds: string[]
  /** The store's sellers and the products each publishes (every product has one). */
  sellers: { sellerId: string; name: string; productIds: string[] }[]
  /** Each campaign is one seller's, with that seller's products. */
  campaigns: { campaignId: string; sellerId: string; productIds: string[] }[]
}

const SEED_PRODUCTS = { min: 10, max: 15 }
const SEED_CAMPAIGN_SIZES = [2, 3]
const SEED_SELLERS = ['Northwind Traders', 'Contoso Goods']

const digest = (key: string, label: string) => createHash('sha256').update(`${key}:${label}`).digest()
const numberBelow = (key: string, label: string, below: number) => digest(key, label).readUInt32BE(0) % below

function uuidFrom(key: string, label: string): string {
  const bytes = digest(key, label).subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4 layout
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The same plan every time for one key. */
export function seedPlan(key: string): SeedPlan {
  const count = SEED_PRODUCTS.min + numberBelow(key, 'product-count', SEED_PRODUCTS.max - SEED_PRODUCTS.min + 1)
  const productIds = Array.from({ length: count }, (_, i) => uuidFrom(key, `product:${i}`))
  // Fisher–Yates shuffle, then consecutive slices: no product is in both campaigns.
  const shuffled = [...productIds]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = numberBelow(key, `shuffle:${i}`, i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }
  // Two sellers: campaign i is seller i % 2's, with its products; the rest alternate.
  const sellers = SEED_SELLERS.map((name, i) => ({ sellerId: uuidFrom(key, `seller:${i}`), name, productIds: [] as string[] }))
  let next = 0
  const campaigns = SEED_CAMPAIGN_SIZES.map((size, i) => {
    const seller = sellers[i % sellers.length]!
    const campaignProducts = shuffled.slice(next, (next += size))
    seller.productIds.push(...campaignProducts)
    return { campaignId: uuidFrom(key, `campaign:${i}`), sellerId: seller.sellerId, productIds: campaignProducts }
  })
  shuffled.slice(next).forEach((productId, i) => sellers[i % sellers.length]!.productIds.push(productId))
  return { productIds, sellers, campaigns }
}
