import { isIsoDate, isUuid } from '@basketline/platform'

export function validateMetricQuery(query: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (query.from !== undefined && !isIsoDate(query.from)) errors.push('from must be an ISO 8601 date-time')
  if (query.to !== undefined && !isIsoDate(query.to)) errors.push('to must be an ISO 8601 date-time')
  // Basketline's ID for the store, as GET /ad/campaigns lists it.
  if (query.storeId !== undefined && !isUuid(query.storeId)) errors.push('storeId must be a store ID (a UUID, from GET /ad/campaigns)')
  return errors
}
