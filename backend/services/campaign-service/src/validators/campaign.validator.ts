import type { CampaignStatus } from '@ecommerce-analytics/contracts'
import { isIsoDate, isNonEmptyString, isOneOf, isPlainObject, isUuid, unknownKeys } from '@ecommerce-analytics/platform'

export const STATUSES: readonly CampaignStatus[] = ['draft', 'active', 'paused', 'completed']

export interface CreateCampaignInput {
  title: string
  type: string
  description?: string | null
  status?: 'draft' | 'active'
  startTime?: string | null
  endTime?: string | null
  productIds?: string[]
}

export interface UpdateCampaignInput {
  title?: string
  type?: string
  description?: string | null
  status?: CampaignStatus
  startTime?: string | null
  endTime?: string | null
}

function checkProductIds(value: unknown, errors: string[], { required }: { required: boolean }) {
  if (value === undefined && !required) return
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > 100) {
    errors.push(required ? 'productIds must be an array of 1–100 product IDs' : 'productIds must be an array of up to 100 product IDs')
    return
  }
  if (!value.every(isUuid)) errors.push('every productId must be a UUID')
}

function checkCommonFields(body: Record<string, unknown>, errors: string[]) {
  if (body.description !== undefined && body.description !== null && (typeof body.description !== 'string' || body.description.length > 10_000)) {
    errors.push('description must be a string (max 10000 characters) or null')
  }
  for (const field of ['startTime', 'endTime'] as const) {
    if (body[field] !== undefined && body[field] !== null && !isIsoDate(body[field])) {
      errors.push(`${field} must be an ISO 8601 date-time with timezone, e.g. 2026-11-01T00:00:00Z`)
    }
  }
}

export function validateCreateCampaign(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, ['title', 'type', 'description', 'status', 'startTime', 'endTime', 'productIds']).map(
    (key) => `unknown field "${key}"`,
  )
  if (!isNonEmptyString(body.title, 255)) errors.push('title is required (max 255 characters)')
  if (!isNonEmptyString(body.type, 100)) errors.push('type is required (max 100 characters)')
  if (body.status !== undefined && !isOneOf(body.status, ['draft', 'active'])) errors.push('status must be "draft" or "active" when creating')
  checkCommonFields(body, errors)
  checkProductIds(body.productIds, errors, { required: false })
  return errors
}

export function validateUpdateCampaign(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, ['title', 'type', 'description', 'status', 'startTime', 'endTime']).map((key) => `unknown field "${key}"`)
  if (Object.keys(body).length === 0) errors.push('provide at least one field to update')
  if (body.title !== undefined && !isNonEmptyString(body.title, 255)) errors.push('title must be a non-empty string (max 255 characters)')
  if (body.type !== undefined && !isNonEmptyString(body.type, 100)) errors.push('type must be a non-empty string (max 100 characters)')
  if (body.status !== undefined && !isOneOf(body.status, STATUSES)) errors.push(`status must be one of ${STATUSES.join(', ')}`)
  checkCommonFields(body, errors)
  return errors
}

export function validateAddProducts(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, ['productIds']).map((key) => `unknown field "${key}"`)
  checkProductIds(body.productIds, errors, { required: true })
  return errors
}

export function validateListCampaignsQuery(query: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (query.status !== undefined && !isOneOf(query.status, STATUSES)) errors.push(`status must be one of ${STATUSES.join(', ')}`)
  if (query.includeArchived !== undefined && query.includeArchived !== 'true' && query.includeArchived !== 'false') {
    errors.push('includeArchived must be true or false')
  }
  return errors
}
