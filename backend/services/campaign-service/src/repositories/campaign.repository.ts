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
  campaign: Pick<CampaignRow, 'id' | 'tenantId' | 'title' | 'type' | 'description' | 'status' | 'startTime' | 'endTime' | 'createdBy' | 'updatedBy'>,
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
  campaign: Pick<CampaignRow, 'id' | 'tenantId' | 'title' | 'type' | 'description' | 'status' | 'startTime' | 'endTime' | 'createdBy' | 'updatedBy'>,
): Promise<CampaignRow | null> {
  const [inserted] = await db.insert(campaigns).values(campaign).onConflictDoNothing({ target: campaigns.id }).returning()
  return inserted ?? null
}
