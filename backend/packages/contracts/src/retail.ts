/**
 * Reference data: what exists at a retailer (its sellers, their products, their
 * campaigns). Shopper events only reference it by ID. It comes only from the
 * retailer's server, with its API key (POST /api/v1/retail/catalog and /api/v1/retail/campaigns),
 * since a browser could otherwise register or change campaigns and products.
 *
 * Every update is the entity's full state with its updatedAt, which orders it:
 * the newest wins, so retries, reordering and several channels (the API now, a
 * catalog file later) can't conflict. The topics keep the latest state per ID
 * (compacted), keyed by the entity's ID.
 */
import { createHash } from 'node:crypto'
import type { CampaignStatus } from './events.ts'

export const CATALOG_TOPIC = 'retail.catalog-events.v1'
export const CAMPAIGN_TOPIC = 'retail.campaign-events.v1'

export const CATALOG_EVENT_NAMES = ['seller_upserted', 'product_upserted', 'product_removed'] as const
export const CAMPAIGN_EVENT_NAMES = ['campaign_upserted', 'campaign_removed'] as const
export type CatalogEventName = (typeof CATALOG_EVENT_NAMES)[number]
export type CampaignEventName = (typeof CAMPAIGN_EVENT_NAMES)[number]

export interface SellerUpserted {
  sellerId: string
  name: string
}

export interface ProductUpserted {
  productId: string
  /** The seller who publishes it (the API fills in the retailer's first-party seller when none is sent). */
  sellerId: string
  name: string
  category: string | null
  price: number | null
  isActive: boolean
}

export interface ProductRemoved {
  productId: string
}

export interface CampaignUpserted {
  campaignId: string
  /** The seller who runs it: its products must be this seller's. */
  sellerId: string
  title: string
  status: CampaignStatus
  startTime: string | null
  endTime: string | null
  archived: boolean
  productIds: string[]
}

export interface CampaignRemoved {
  campaignId: string
}

export interface ReferencePayloads {
  seller_upserted: SellerUpserted
  product_upserted: ProductUpserted
  product_removed: ProductRemoved
  campaign_upserted: CampaignUpserted
  campaign_removed: CampaignRemoved
}

/** The payload of a reference event on its topic: the tenant, when the state is from, and the state. */
export type ReferenceEventPayload<N extends keyof ReferencePayloads = keyof ReferencePayloads> = ReferencePayloads[N] & {
  tenantId: string
  updatedAt: string
}

/** A retailer's ID for a seller, product or campaign: a UUID, or its own ID (a SKU, a code). */
export function isRetailerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

/** A tenant's own seller, for products sent without one (a store selling only its own goods). */
export const FIRST_PARTY_SELLER = 'first-party'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A fixed namespace, so the same retailer ID always gives the same UUID.
const NAMESPACE = Buffer.from('6f1c9a3e2b7d4e5f8a9b0c1d2e3f4a5b', 'hex')

/**
 * The UUID for a retailer's own ID (a SKU, a seller code, a campaign code):
 * a version-5 UUID of the tenant, the kind of ID and the value. Retailers keep
 * their IDs; every channel maps them the same; two tenants' IDs never collide;
 * storage keeps its UUID columns. A value that is already a UUID is used as is
 * (lowercased), so clients that send UUIDs keep working.
 */
export function externalId(tenantId: string, kind: 'seller' | 'product' | 'campaign', value: string): string {
  if (UUID.test(value)) return value.toLowerCase()
  const hash = createHash('sha1').update(NAMESPACE).update(`${tenantId.toLowerCase()}:${kind}:${value}`).digest()
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
