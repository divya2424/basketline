/**
 * products: this service's copy of the product catalog, kept up to date from
 * product.v1 events. A write applies unless the incoming version is older, so
 * stale and out-of-order events are ignored, and a redelivered or republished
 * event (same version, same state) at most rewrites the same values.
 */
import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import type { ProductState } from '@basketline/contracts'
import type { DbOrTx } from '../db/client.ts'
import { products } from '../db/schema.ts'

const isNotOlder = lte(products.productVersion, sql`excluded.product_version`)

/**
 * Active flag of each known product of the tenant (another tenant's product is not
 * known); FOR SHARE blocks a concurrent deactivation until commit.
 */
export async function findKnownProducts(db: DbOrTx, tenantId: string, productIds: string[]): Promise<Map<string, { isActive: boolean; sellerId: string | null }>> {
  const rows = await db
    .select({ productId: products.productId, isActive: products.isActive, sellerId: products.sellerId })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), inArray(products.productId, productIds)))
    .for('share')
  return new Map(rows.map(({ productId, ...known }) => [productId, known]))
}

export async function upsertProductState(db: DbOrTx, product: ProductState, version: number) {
  const values = {
    sellerId: product.sellerId ?? null,
    name: product.name,
    price: product.price,
    image: product.image,
    category: product.category,
    isActive: product.isActive,
    productVersion: version,
    updatedAt: new Date(product.updatedAt),
    // Missing in events published before these fields existed.
    createdAt: product.createdAt ? new Date(product.createdAt) : null,
    createdBy: product.createdBy ?? null,
    updatedBy: product.updatedBy ?? null,
  }
  await db
    .insert(products)
    .values({ productId: product.productId, tenantId: product.tenantId, ...values })
    .onConflictDoUpdate({ target: products.productId, set: values, setWhere: isNotOlder })
}

/** Also records a deactivation that arrives before the product's creation event. */
export async function markProductInactive(db: DbOrTx, productId: string, tenantId: string, version: number, at: string, by: string | null) {
  const values = { isActive: false, productVersion: version, updatedAt: new Date(at), updatedBy: by }
  await db
    .insert(products)
    .values({ productId, tenantId, ...values })
    .onConflictDoUpdate({ target: products.productId, set: values, setWhere: isNotOlder })
}
