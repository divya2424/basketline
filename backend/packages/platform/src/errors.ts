export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  readonly retryAfterSeconds: number | undefined

  constructor(status: number, code: string, message: string, details?: unknown, retryAfterSeconds?: number) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details)
export const unauthorized = (code: string, message: string) => new AppError(401, code, message)
export const forbidden = (code: string, message: string) => new AppError(403, code, message)
export const notFound = (code: string, message: string) => new AppError(404, code, message)
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details)
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details)
export const serviceUnavailable = (code: string, message: string) => new AppError(503, code, message)
/**
 * 409 + Retry-After: the request conflicts with this service's current local
 * state but may succeed later (e.g. a projection hasn't caught up yet).
 */
export const retryLater = (code: string, message: string, retryAfterSeconds: number, details?: unknown) =>
  new AppError(409, code, message, { retryable: true, ...((details as object | undefined) ?? {}) }, retryAfterSeconds)
