import { isNonEmptyString, isPlainObject, isPrice, unknownKeys } from '@shopsphere/platform'

const FIELDS = ['name', 'description', 'price', 'image', 'category'] as const

export interface CreateProductInput {
  name: string
  description: string
  price: number
  image?: string | null
  category?: string | null
}

export type UpdateProductInput = Partial<CreateProductInput> & { isActive?: true }

function isImage(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 2048 && (value.startsWith('/') || /^https?:\/\//.test(value))
}

function checkOptionalFields(body: Record<string, unknown>, errors: string[]) {
  if (body.image !== undefined && body.image !== null && !isImage(body.image)) {
    errors.push('image must be an http(s) URL or a path starting with /')
  }
  if (body.category !== undefined && body.category !== null && !isNonEmptyString(body.category, 100)) {
    errors.push('category must be a non-empty string (max 100 characters)')
  }
}

export function validateCreateProduct(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, FIELDS).map((key) => `unknown field "${key}"`)
  if (!isNonEmptyString(body.name, 255)) errors.push('name is required (max 255 characters)')
  if (!isNonEmptyString(body.description, 10_000)) errors.push('description is required (max 10000 characters)')
  if (!isPrice(body.price)) errors.push('price must be a number greater than 0 with at most 2 decimals')
  checkOptionalFields(body, errors)
  return errors
}

export function validateUpdateProduct(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, [...FIELDS, 'isActive']).map((key) => `unknown field "${key}"`)
  if (Object.keys(body).length === 0) errors.push('provide at least one field to update')
  if (body.name !== undefined && !isNonEmptyString(body.name, 255)) errors.push('name must be a non-empty string (max 255 characters)')
  if (body.description !== undefined && !isNonEmptyString(body.description, 10_000)) errors.push('description must be a non-empty string')
  if (body.price !== undefined && !isPrice(body.price)) errors.push('price must be a number greater than 0 with at most 2 decimals')
  if (body.isActive !== undefined && body.isActive !== true) errors.push('isActive can only be set to true (use DELETE to deactivate)')
  checkOptionalFields(body, errors)
  return errors
}

export function validateListProductsQuery(query: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (query.includeInactive !== undefined && query.includeInactive !== 'true' && query.includeInactive !== 'false') {
    errors.push('includeInactive must be true or false')
  }
  if (query.category !== undefined && !isNonEmptyString(query.category, 100)) errors.push('category must be a non-empty string')
  return errors
}
