import { badRequest } from './errors.ts'

const MAX_LIMIT = 100

/** Reads ?limit (1–100, default 20) and ?offset (default 0) from a query string. */
export function readPagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = query.limit === undefined ? 20 : Number(query.limit)
  const offset = query.offset === undefined ? 0 : Number(query.offset)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest('VALIDATION_FAILED', 'Invalid pagination', { errors: [`limit must be an integer from 1 to ${MAX_LIMIT}`] })
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw badRequest('VALIDATION_FAILED', 'Invalid pagination', { errors: ['offset must be a non-negative integer'] })
  }
  return { limit, offset }
}

export function page<T>(items: T[], total: number, limit: number, offset: number) {
  return { items, page: { limit, offset, total } }
}
