import { isNonEmptyString, isOneOf, isPlainObject, isUuid, unknownKeys } from '@basketline/platform'

/** Basketline's account tiers. */
const TIERS = ['free', 'pro', 'enterprise'] as const

export interface ConnectInput {
  name: string
  tier: (typeof TIERS)[number]
}

export interface ShopperTokenInput {
  /** The Basketline SDK's visitor ID for this browser: the customer keeps it, so they stay one person. */
  visitorId?: string
  clientType?: 'web' | 'mobile'
}

export interface LoginInput extends ShopperTokenInput {
  username: string
  password: string
}

export function validateConnect(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, ['name', 'tier']).map((key) => `unknown field "${key}"`)
  if (typeof body.name !== 'string' || !isNonEmptyString(body.name.trim(), 200)) errors.push('name must be 1–200 characters')
  if (!isOneOf(body.tier, TIERS)) errors.push(`tier must be one of ${TIERS.join(', ')}`)
  return errors
}

function shopperErrors(body: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (body.visitorId !== undefined && !isUuid(body.visitorId)) errors.push('visitorId must be a UUID')
  if (body.clientType !== undefined && !isOneOf(body.clientType, ['web', 'mobile'])) errors.push('clientType must be "web" or "mobile"')
  return errors
}

export function validateLogin(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, ['username', 'password', 'visitorId', 'clientType']).map((key) => `unknown field "${key}"`)
  if (!isNonEmptyString(body.username, 100)) errors.push('username is required')
  if (typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 256) errors.push('password is required')
  return [...errors, ...shopperErrors(body)]
}

export function validateShopperToken(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  return [...unknownKeys(body, ['visitorId', 'clientType']).map((key) => `unknown field "${key}"`), ...shopperErrors(body)]
}
