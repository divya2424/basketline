import { isNonEmptyString, isPlainObject, unknownKeys } from '@basketline/platform'

/** A placement's key: lowercase letters, digits, _ and -, e.g. top_rated. */
export const isPlacementKey = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
const isPosition = (value: unknown) => Number.isInteger(value) && (value as number) >= 0

export interface CreatePlacementInput {
  key: string
  name: string
  position: number
}

export interface UpdatePlacementInput {
  name?: string
  position?: number
  active?: boolean
}

export function validateCreatePlacement(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, ['key', 'name', 'position']).map((key) => `unknown field "${key}"`)
  if (!isPlacementKey(body.key)) errors.push('key is required: lowercase letters, digits, _ and - (max 64), e.g. top_rated')
  if (!isNonEmptyString(body.name, 100)) errors.push('name is required (max 100 characters)')
  if (!isPosition(body.position)) errors.push('position is required: an integer ≥ 0 (the section order)')
  return errors
}

export function validateUpdatePlacement(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, ['name', 'position', 'active']).map((key) => `unknown field "${key}"`)
  if (Object.keys(body).length === 0) errors.push('provide at least one field to update')
  if (body.name !== undefined && !isNonEmptyString(body.name, 100)) errors.push('name must be a non-empty string (max 100 characters)')
  if (body.position !== undefined && !isPosition(body.position)) errors.push('position must be an integer ≥ 0')
  if (body.active !== undefined && typeof body.active !== 'boolean') errors.push('active must be true or false')
  return errors
}
