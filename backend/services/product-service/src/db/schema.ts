/**
 * product_db tables — the source of truth for the schema. After a change run
 * `pnpm --filter @basketline/product-service db:generate`; migrations apply on startup.
 */
import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, numeric, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core'
// The tables module, not the package root: drizzle-kit loads this file with require(),
// and the root also loads the Kafka bus, which is ESM only.
import { timestamptz } from '@basketline/platform/tables'

export { auditLog } from '@basketline/platform/tables'

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    // The owning tenant (from the manager's token). Every query is scoped by it.
    tenantId: uuid('tenant_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description').notNull(),
    price: numeric('price', { precision: 12, scale: 2, mode: 'number' }).notNull(),
    image: text('image'),
    category: varchar('category', { length: 100 }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    // The users who created and last changed the product (from their tokens).
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    // Bumped on every change; consumers use it to ignore stale events.
    version: bigint('version', { mode: 'number' }).notNull().default(1),
  },
  (table) => [
    check('products_price_check', sql`${table.price} > 0`),
    index('products_active_created_idx').on(table.tenantId, table.isActive, table.createdAt.desc()),
    index('products_category_idx').on(table.tenantId, table.category),
  ],
)
