/**
 * campaign_db tables — the source of truth for the schema. After a change run
 * `npm run db:generate -w @ecommerce-analytics/campaign-service`; migrations apply on startup.
 */
import { relations, sql } from 'drizzle-orm'
import { bigint, boolean, check, index, integer, numeric, pgEnum, pgTable, text, unique, uuid, varchar } from 'drizzle-orm/pg-core'
import { timestamptz } from '@ecommerce-analytics/platform'

export { auditLog } from '@ecommerce-analytics/platform'

export const campaignStatus = pgEnum('campaign_status', ['draft', 'active', 'paused', 'completed'])

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey(),
    // The owning tenant (from the manager's token). Every query is scoped by it.
    tenantId: uuid('tenant_id').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    type: varchar('type', { length: 100 }).notNull(),
    description: text('description'),
    status: campaignStatus('status').notNull().default('draft'),
    startTime: timestamptz('start_time'),
    endTime: timestamptz('end_time'),
    createdBy: uuid('campaign_created_by').notNull(),
    updatedBy: uuid('campaign_updated_by').notNull(),
    createdAt: timestamptz('campaign_created_at').notNull().defaultNow(),
    updatedAt: timestamptz('campaign_updated_at').notNull().defaultNow(),
    // Soft delete: DELETE /campaigns/:id sets this.
    archivedAt: timestamptz('archived_at'),
    // Bumped by every change, including product associations.
    version: bigint('version', { mode: 'number' }).notNull().default(1),
  },
  (table) => [
    check('campaigns_schedule_check', sql`${table.startTime} IS NULL OR ${table.endTime} IS NULL OR ${table.endTime} > ${table.startTime}`),
    index('campaigns_listing_idx').on(table.tenantId, table.status, table.createdAt.desc()).where(sql`${table.archivedAt} IS NULL`),
  ],
)

export const campaignProducts = pgTable(
  'campaign_products',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    // The campaign's tenant, so associations can be queried per tenant on their own.
    tenantId: uuid('tenant_id').notNull(),
    // No foreign key: products belong to the product service.
    productId: uuid('product_id').notNull(),
    position: integer('position'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    // The manager who added the product (associations are added and removed, never edited).
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
  },
  (table) => [
    unique('campaign_products_unique').on(table.campaignId, table.productId),
    index('campaign_products_campaign_idx').on(table.campaignId),
    index('campaign_products_product_idx').on(table.productId),
  ],
)

/**
 * This service's copy of the product catalog, kept up to date from product.v1
 * events, so it never queries the product service. Everything but the IDs and
 * flags is nullable: a deactivation can arrive before the product's creation
 * event, and events from before createdAt/createdBy existed lack them.
 */
export const products = pgTable('products', {
  productId: uuid('product_id').primaryKey(),
  // A campaign can only use its own tenant's products.
  tenantId: uuid('tenant_id').notNull(),
  name: varchar('name', { length: 255 }),
  price: numeric('price', { precision: 12, scale: 2, mode: 'number' }),
  image: text('image'),
  category: varchar('category', { length: 100 }),
  isActive: boolean('is_active').notNull(),
  productVersion: bigint('product_version', { mode: 'number' }).notNull(),
  createdAt: timestamptz('created_at'),
  updatedAt: timestamptz('updated_at').notNull(),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
})

export const campaignsRelations = relations(campaigns, ({ many }) => ({ products: many(campaignProducts) }))
export const campaignProductsRelations = relations(campaignProducts, ({ one }) => ({
  campaign: one(campaigns, { fields: [campaignProducts.campaignId], references: [campaigns.id] }),
}))
