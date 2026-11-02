import { and, asc, count, desc, eq, isNull, max, sql, type SQL } from 'drizzle-orm'
import type { CampaignStatus } from '@basketline/contracts'
import type { DbOrTx } from '../db/client.ts'
import { campaignProducts, campaigns, products } from '../db/schema.ts'

type CampaignRow = typeof campaigns.$inferSelect
/** A campaign with its product IDs in position order. */
export type Campaign = CampaignRow & { productIds: string[] }

const withProductIds = {
  products: {
    columns: { productId: true as const },
    orderBy: [asc(campaignProducts.position), asc(campaignProducts.createdAt)],
  },
}

const toCampaign = ({ products, ...campaign }: CampaignRow & { products: { productId: string }[] }): Campaign => ({
  ...campaign,
  productIds: products.map((product) => product.productId),
})

/** Campaigns are only found within their tenant: another tenant's campaign is not found. */
const inTenant = (tenantId: string, id: string) => and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, id))

export async function findCampaign(db: DbOrTx, tenantId: string, id: string): Promise<Campaign | null> {
  const campaign = await db.query.campaigns.findFirst({ where: inTenant(tenantId, id), with: withProductIds })
  return campaign ? toCampaign(campaign) : null
}

/** Locks the row until the transaction ends. */
export async function lockCampaign(db: DbOrTx, tenantId: string, id: string): Promise<CampaignRow | null> {
  const [campaign] = await db.select().from(campaigns).where(inTenant(tenantId, id)).for('update')
  return campaign ?? null
}

export interface CampaignFilter {
  tenantId: string
  status?: CampaignStatus
  includeArchived: boolean
  limit: number
  offset: number
}

export async function listCampaigns(db: DbOrTx, filter: CampaignFilter): Promise<{ items: Campaign[]; total: number }> {
  const conditions: SQL[] = [eq(campaigns.tenantId, filter.tenantId)]
  if (!filter.includeArchived) conditions.push(isNull(campaigns.archivedAt))
  if (filter.status) conditions.push(eq(campaigns.status, filter.status))
  const where = and(...conditions)

  const [items, [totals]] = await Promise.all([
    db.query.campaigns.findMany({
      where,
      with: withProductIds,
      orderBy: [desc(campaigns.createdAt), asc(campaigns.id)],
      limit: filter.limit,
      offset: filter.offset,
    }),
    db.select({ total: count() }).from(campaigns).where(where),
  ])
  return { items: items.map(toCampaign), total: totals?.total ?? 0 }
}

export async function insertCampaign(
  db: DbOrTx,
  campaign: Pick<CampaignRow, 'id' | 'tenantId' | 'sellerId' | 'title' | 'type' | 'description' | 'status' | 'startTime' | 'endTime' | 'createdBy' | 'updatedBy'>,
): Promise<CampaignRow> {
  const [inserted] = await db.insert(campaigns).values(campaign).returning()
  return inserted!
}

/** Applies changes, records who made them and bumps the version. Every campaign change goes through here. */
export async function updateCampaign(
  db: DbOrTx,
  id: string,
  updatedBy: string,
  changes: Partial<Pick<CampaignRow, 'title' | 'type' | 'description' | 'status' | 'startTime' | 'endTime' | 'archivedAt'>> = {},
): Promise<CampaignRow> {
  const [updated] = await db
    .update(campaigns)
    .set({ ...changes, updatedBy, updatedAt: sql`now()`, version: sql`${campaigns.version} + 1` })
    .where(eq(campaigns.id, id))
    .returning()
  return updated!
}

export async function nextPosition(db: DbOrTx, campaignId: string): Promise<number> {
  const [row] = await db.select({ last: max(campaignProducts.position) }).from(campaignProducts).where(eq(campaignProducts.campaignId, campaignId))
  return (row?.last ?? 0) + 1
}

/** Throws a unique violation on campaign_products_unique if already associated. */
export async function insertAssociation(db: DbOrTx, association: { id: string; tenantId: string; campaignId: string; productId: string; position: number; createdBy: string }) {
  // Associations are added and removed, never edited, so the creator is also the last updater.
  await db.insert(campaignProducts).values({ ...association, updatedBy: association.createdBy })
}

/** Returns false if the product wasn't in the campaign. */
export async function deleteAssociation(db: DbOrTx, campaignId: string, productId: string): Promise<boolean> {
  const deleted = await db
    .delete(campaignProducts)
    .where(and(eq(campaignProducts.campaignId, campaignId), eq(campaignProducts.productId, productId)))
    .returning({ id: campaignProducts.id })
  return deleted.length > 0
}

/** The campaign's products with details from the local products copy (null if not known yet). */
export async function listCampaignProducts(db: DbOrTx, campaignId: string, limit: number, offset: number) {
  const [items, [totals]] = await Promise.all([
    db
      .select({
        productId: campaignProducts.productId,
        position: campaignProducts.position,
        associatedAt: campaignProducts.createdAt,
        name: products.name,
        price: products.price,
        image: products.image,
        category: products.category,
        isActive: products.isActive,
      })
      .from(campaignProducts)
      .leftJoin(products, eq(products.productId, campaignProducts.productId))
      .where(eq(campaignProducts.campaignId, campaignId))
      .orderBy(asc(campaignProducts.position), asc(campaignProducts.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(campaignProducts).where(eq(campaignProducts.campaignId, campaignId)),
  ])
  return { items, total: totals?.total ?? 0 }
}

/** Inserts the campaign unless its ID exists; returns it, or null when it already existed. */
export async function insertCampaignIfAbsent(
  db: DbOrTx,
  campaign: Pick<CampaignRow, 'id' | 'tenantId' | 'sellerId' | 'title' | 'type' | 'description' | 'status' | 'startTime' | 'endTime' | 'createdBy' | 'updatedBy'>,
): Promise<CampaignRow | null> {
  const [inserted] = await db.insert(campaigns).values(campaign).onConflictDoNothing({ target: campaigns.id }).returning()
  return inserted ?? null
}

/** Every campaign of a deleted tenant, its product associations, and this service's copy of its products. */
export async function deleteTenantCampaigns(db: DbOrTx, tenantId: string): Promise<void> {
  await db.delete(campaignProducts).where(eq(campaignProducts.tenantId, tenantId))
  await db.delete(campaigns).where(eq(campaigns.tenantId, tenantId))
  await db.delete(products).where(eq(products.tenantId, tenantId))
}

export async function listAllCampaigns(db: DbOrTx): Promise<Campaign[]> {
  return (await db.query.campaigns.findMany({ with: withProductIds, orderBy: [asc(campaigns.tenantId), asc(campaigns.id)] })).map(toCampaign)
}

/**
 * Gives each campaign from before sellers the seller of its products, when the
 * products copy knows all of them and they share one; updated_at moves so the
 * new state wins downstream. Returns how many campaigns got one.
 */
export async function fillCampaignSellers(db: DbOrTx): Promise<number> {
  const result = await db.execute(sql`
    UPDATE campaigns c SET seller_id = s.seller_id, campaign_updated_at = now()
    FROM (
      SELECT cp.campaign_id, (array_agg(p.seller_id))[1] AS seller_id
      FROM campaign_products cp LEFT JOIN products p ON p.product_id = cp.product_id AND p.tenant_id = cp.tenant_id
      GROUP BY cp.campaign_id
      HAVING count(p.seller_id) = count(*) AND count(DISTINCT p.seller_id) = 1
    ) s
    WHERE c.id = s.campaign_id AND c.seller_id IS NULL`)
  return result.rowCount ?? 0
}
