import type { CampaignStatus } from '@retailer-sim/shared'
import { isIsoDate, isNonEmptyString, isOneOf, isPlainObject, isUuid, unknownKeys } from '@basketline/platform'
import { isPlacementKey } from './placement.validator.ts'

export const STATUSES: readonly CampaignStatus[] = ['draft', 'active', 'paused', 'completed']

export interface CreateCampaignInput {
  /**
   * The seller running it (one of the tenant's: product-service GET /sellers); its
   * products must be this seller's. Staff name it; a seller's is its own.
   */
  sellerId?: string
  title: string
  /** One of the tenant's active placements (GET /placements), by key. */
  placement: string
  description?: string | null
  status?: 'draft' | 'active'
  startTime?: string | null
  endTime?: string | null
  productIds?: string[]
}

export interface UpdateCampaignInput {
  title?: string
  placement?: string
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
  const errors = unknownKeys(body, ['sellerId', 'title', 'placement', 'description', 'status', 'startTime', 'endTime', 'productIds']).map(
    (key) => `unknown field "${key}"`,
  )
  if (body.sellerId !== undefined && !isUuid(body.sellerId)) errors.push('sellerId must be a seller ID (GET /sellers)')
  if (!isNonEmptyString(body.title, 255)) errors.push('title is required (max 255 characters)')
  if (!isPlacementKey(body.placement)) errors.push('placement is required: a placement key (GET /placements), e.g. spotlight')
  if (body.status !== undefined && !isOneOf(body.status, ['draft', 'active'])) errors.push('status must be "draft" or "active" when creating')
  checkCommonFields(body, errors)
  checkProductIds(body.productIds, errors, { required: false })
  return errors
}

export function validateUpdateCampaign(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, ['title', 'placement', 'description', 'status', 'startTime', 'endTime']).map((key) => `unknown field "${key}"`)
  if (Object.keys(body).length === 0) errors.push('provide at least one field to update')
  if (body.title !== undefined && !isNonEmptyString(body.title, 255)) errors.push('title must be a non-empty string (max 255 characters)')
  if (body.placement !== undefined && !isPlacementKey(body.placement)) errors.push('placement must be a placement key (GET /placements)')
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
  if (query.sellerId !== undefined && !isUuid(query.sellerId)) errors.push('sellerId must be a UUID')
  if (query.status !== undefined && !isOneOf(query.status, STATUSES)) errors.push(`status must be one of ${STATUSES.join(', ')}`)
  if (query.includeArchived !== undefined && query.includeArchived !== 'true' && query.includeArchived !== 'false') {
    errors.push('includeArchived must be true or false')
  }
  return errors
}

export function validateResultsQuery(query: Record<string, unknown>): string[] {
  const errors: string[] = []
  for (const field of ['from', 'to'] as const) {
    if (query[field] !== undefined && !isIsoDate(query[field])) errors.push(`${field} must be an ISO 8601 date-time with timezone`)
  }
  return errors
}
