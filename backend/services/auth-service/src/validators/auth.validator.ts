import { isNonEmptyString, isOneOf, isPlainObject, unknownKeys } from '@shopsphere/platform'

export interface RegisterInput {
  username: string
  password: string
}

export interface LoginInput {
  username: string
  password: string
  clientType: 'web' | 'mobile'
}

const USERNAME = /^[A-Za-z0-9_.-]{3,100}$/

/**
 * Unknown fields (such as "role") are rejected, so registration can never
 * grant the campaign-manager role.
 */
export function validateRegister(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, ['username', 'password']).map((key) => `unknown field "${key}"`)
  if (typeof body.username !== 'string' || !USERNAME.test(body.username.trim())) {
    errors.push('username must be 3–100 characters: letters, digits, ".", "_" or "-"')
  }
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 256) {
    errors.push('password must be 12–256 characters')
  }
  return errors
}

export function validateLogin(body: unknown): string[] {
  if (!isPlainObject(body)) return ['body must be a JSON object']
  const errors = unknownKeys(body, ['username', 'password', 'clientType']).map((key) => `unknown field "${key}"`)
  if (!isNonEmptyString(body.username, 100)) errors.push('username is required')
  if (typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 256) errors.push('password is required')
  if (!isOneOf(body.clientType, ['web', 'mobile'])) errors.push('clientType must be "web" or "mobile"')
  return errors
}
