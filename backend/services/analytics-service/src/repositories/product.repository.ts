/**
 * analytics.sellers and analytics.products: this service's copy of a retailer's
 * catalog, from retail.catalog-events.v1. ReplacingMergeTree(version) keeps the
 * newest version, so replays and out-of-order events are harmless.
 */
import type { ReferenceEventPayload } from '@basketline/contracts'
import type { ClickHouse } from '../clickhouse.ts'

export async function upsertSeller(clickhouse: ClickHouse, seller: ReferenceEventPayload<'seller_upserted'>, version: number): Promise<void> {
  await clickhouse.insert({
    table: 'sellers',
    format: 'JSONEachRow',
    values: [{ seller_id: seller.sellerId, tenant_id: seller.tenantId, name: seller.name, version }],
  })
}

export async function upsertProduct(clickhouse: ClickHouse, product: ReferenceEventPayload<'product_upserted'>, version: number, removed = false): Promise<void> {
  await clickhouse.insert({
    table: 'products',
    format: 'JSONEachRow',
    values: [{
      product_id: product.productId,
      tenant_id: product.tenantId,
      seller_id: product.sellerId,
      name: product.name,
      category: product.category,
      price: product.price,
      is_active: product.isActive && !removed,
      removed,
      version,
    }],
  })
}

/** The seller of each of `ids` the catalog has sent (removed products included: their events keep their seller). */
export async function findProductSellers(clickhouse: ClickHouse, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const result = await clickhouse.query({
    query: `SELECT toString(product_id) AS id, toString(argMax(seller_id, version)) AS seller FROM products
            WHERE tenant_id = {tenantId:UUID} AND product_id IN {ids:Array(UUID)} GROUP BY product_id`,
    query_params: { tenantId, ids },
    format: 'JSONEachRow',
  })
  return new Map((await result.json<{ id: string; seller: string }>()).map((row) => [row.id, row.seller]))
}

/** The newest state of a product, to mark it removed. */
export async function findProduct(clickhouse: ClickHouse, tenantId: string, productId: string): Promise<ReferenceEventPayload<'product_upserted'> | undefined> {
  const result = await clickhouse.query({
    query: `SELECT toString(product_id) AS productId, toString(tenant_id) AS tenantId, toString(argMax(seller_id, version)) AS sellerId,
                   argMax(name, version) AS name, argMax(category, version) AS category, argMax(price, version) AS price,
                   argMax(is_active, version) AS isActive
            FROM products WHERE tenant_id = {tenantId:UUID} AND product_id = {productId:UUID} GROUP BY product_id, tenant_id`,
    query_params: { tenantId, productId },
    format: 'JSONEachRow',
  })
  const [row] = await result.json<Omit<ReferenceEventPayload<'product_upserted'>, 'updatedAt'>>()
  return row && { ...row, updatedAt: '' }
}
