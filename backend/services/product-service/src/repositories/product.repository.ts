import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.ts'
import { products, sellers } from '../db/schema.ts'

/** A product row: camelCase fields, numeric price, Date timestamps. */
export type Product = typeof products.$inferSelect

export async function insertProduct(
  db: DbOrTx,
  product: Pick<Product, 'id' | 'tenantId' | 'sellerId' | 'name' | 'description' | 'price' | 'image' | 'category' | 'createdBy' | 'updatedBy'>,
): Promise<Product> {
  const [inserted] = await db.insert(products).values(product).returning()
  return inserted!
}

/** Products are only found within their tenant: another tenant's product is not found. */
export async function findProductById(db: DbOrTx, tenantId: string, id: string, { forUpdate = false } = {}): Promise<Product | null> {
  const query = db.select().from(products).where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
  const [product] = forUpdate ? await query.for('update') : await query
  return product ?? null
}

export interface ProductFilter {
  tenantId: string
  category?: string
  includeInactive: boolean
  limit: number
  offset: number
}

export async function listProducts(db: DbOrTx, filter: ProductFilter): Promise<{ items: Product[]; total: number }> {
  const conditions: SQL[] = [eq(products.tenantId, filter.tenantId)]
  if (!filter.includeInactive) conditions.push(eq(products.isActive, true))
  if (filter.category) conditions.push(eq(products.category, filter.category))
  const where = and(...conditions)

  const [items, [totals]] = await Promise.all([
    db.select().from(products).where(where).orderBy(desc(products.createdAt), products.id).limit(filter.limit).offset(filter.offset),
    db.select({ total: count() }).from(products).where(where),
  ])
  return { items, total: totals?.total ?? 0 }
}

/** Writes the full editable state and bumps the version. */
export async function updateProduct(
  db: DbOrTx,
  product: Pick<Product, 'id' | 'name' | 'description' | 'price' | 'image' | 'category' | 'isActive' | 'updatedBy'>,
): Promise<Product> {
  const { id, ...fields } = product
  const [updated] = await db
    .update(products)
    .set({ ...fields, updatedAt: sql`now()`, version: sql`${products.version} + 1` })
    .where(eq(products.id, id))
    .returning()
  return updated!
}

/** Every product of every tenant, oldest first (for republishing their state). */
export function listAllProducts(db: DbOrTx): Promise<Product[]> {
  return db.select().from(products).orderBy(products.createdAt, products.id)
}

/** Inserts the product unless its ID exists; returns it, or null when it already existed. */
export async function insertProductIfAbsent(
  db: DbOrTx,
  product: Pick<Product, 'id' | 'tenantId' | 'sellerId' | 'name' | 'description' | 'price' | 'image' | 'category' | 'createdBy' | 'updatedBy'>,
): Promise<Product | null> {
  const [inserted] = await db.insert(products).values(product).onConflictDoNothing({ target: products.id }).returning()
  return inserted ?? null
}

/** Every product of a deleted tenant. */
export async function deleteTenantProducts(db: DbOrTx, tenantId: string): Promise<number> {
  const deleted = await db.delete(products).where(eq(products.tenantId, tenantId)).returning({ id: products.id })
  await db.delete(sellers).where(eq(sellers.tenantId, tenantId))
  return deleted.length
}

export type Seller = typeof sellers.$inferSelect

export function listSellers(db: DbOrTx, tenantId: string): Promise<Seller[]> {
  return db.select().from(sellers).where(eq(sellers.tenantId, tenantId)).orderBy(sellers.name)
}

export async function findSeller(db: DbOrTx, tenantId: string, id: string): Promise<Seller | undefined> {
  const [seller] = await db.select().from(sellers).where(and(eq(sellers.tenantId, tenantId), eq(sellers.id, id)))
  return seller
}

/** Seeding: inserted by its planned ID, so applying the plan again changes nothing. */
export async function insertSellerIfAbsent(db: DbOrTx, seller: Pick<Seller, 'id' | 'tenantId' | 'name'>): Promise<Seller | null> {
  const [inserted] = await db.insert(sellers).values(seller).onConflictDoNothing().returning()
  return inserted ?? null
}
