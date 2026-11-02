import { isIsoDate } from '@basketline/platform'

export function validateMetricQuery(query: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (query.from !== undefined && !isIsoDate(query.from)) errors.push('from must be an ISO 8601 date-time')
  if (query.to !== undefined && !isIsoDate(query.to)) errors.push('to must be an ISO 8601 date-time')
  return errors
}
