import { randomUUID } from 'node:crypto'
import { event, notFound, writeAudit, type NewEvent, type PublishEvents } from '@shopsphere/platform'
import type { Db, DbOrTx } from '../db/client.ts'
import {
  findProductById,
  insertProduct,
  listProducts,
  updateProduct,
  type Product,
  type ProductFilter,
} from '../repositories/product.repository.ts'
import type { CreateProductInput, UpdateProductInput } from '../validators/product.validator.ts'

export function stateEvent(product: Product, eventType: 'ProductCreated' | 'ProductUpdated'): NewEvent {
  return event(eventType, product.id, product.version, {
    productId: product.id,
    tenantId: product.tenantId,
    name: product.name,
    price: product.price,
    image: product.image,
    category: product.category,
    isActive: product.isActive,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    createdBy: product.createdBy,
    updatedBy: product.updatedBy,
  })
}

/**
 * Business rules for products. Events are published after each transaction commits.
 * Every method works within one tenant: another tenant's product is not found.
 */
export function createProductService({ db, publish }: { db: Db; publish: PublishEvents }) {
  async function requireForUpdate(tx: DbOrTx, tenantId: string, id: string) {
    const product = await findProductById(tx, tenantId, id, { forUpdate: true })
    if (!product) throw notFound('PRODUCT_NOT_FOUND', 'Product not found')
    return product
  }

  return {
    async create(tenantId: string, actorId: string, input: CreateProductInput): Promise<Product> {
      const product = await db.transaction(async (tx) => {
        const product = await insertProduct(tx, {
          id: randomUUID(),
          tenantId,
          name: input.name,
          description: input.description,
          price: input.price,
          image: input.image ?? null,
          category: input.category ?? null,
          createdBy: actorId,
          updatedBy: actorId,
        })
        await writeAudit(tx, { actorId, action: 'product.created', subjectType: 'product', subjectId: product.id })
        return product
      })
      await publish([stateEvent(product, 'ProductCreated')])
      return product
    },

    list(filter: ProductFilter) {
      return listProducts(db, filter)
    },

    async get(tenantId: string, id: string): Promise<Product> {
      const product = await findProductById(db, tenantId, id)
      if (!product) throw notFound('PRODUCT_NOT_FOUND', 'Product not found')
      return product
    },

    /** Partial update; the product ID never changes. */
    async update(tenantId: string, actorId: string, id: string, input: UpdateProductInput): Promise<Product> {
      const product = await db.transaction(async (tx) => {
        const current = await requireForUpdate(tx, tenantId, id)
        const product = await updateProduct(tx, {
          id: current.id,
          name: input.name ?? current.name,
          description: input.description ?? current.description,
          price: input.price ?? current.price,
          image: input.image === undefined ? current.image : input.image,
          category: input.category === undefined ? current.category : input.category,
          isActive: input.isActive ?? current.isActive,
          updatedBy: actorId,
        })
        await writeAudit(tx, { actorId, action: 'product.updated', subjectType: 'product', subjectId: product.id, details: { fields: Object.keys(input) } })
        return product
      })
      await publish([stateEvent(product, 'ProductUpdated')])
      return product
    },

    /** Soft delete: products may still be referenced by campaigns and analytics. Idempotent. */
    async deactivate(tenantId: string, actorId: string, id: string): Promise<Product> {
      const { product, changed } = await db.transaction(async (tx) => {
        const current = await requireForUpdate(tx, tenantId, id)
        if (!current.isActive) return { product: current, changed: false }
        const updated = await updateProduct(tx, { ...current, isActive: false, updatedBy: actorId })
        await writeAudit(tx, { actorId, action: 'product.deactivated', subjectType: 'product', subjectId: updated.id })
        return { product: updated, changed: true }
      })
      if (changed) {
        await publish([
          event('ProductDeactivated', product.id, product.version, {
            productId: product.id,
            tenantId: product.tenantId,
            deactivatedAt: product.updatedAt.toISOString(),
            deactivatedBy: actorId,
          }),
        ])
      }
      return product
    },
  }
}

export type ProductService = ReturnType<typeof createProductService>
