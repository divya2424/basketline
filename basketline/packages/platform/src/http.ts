/**
 * Plain Express building blocks shared by every service: the base app,
 * authentication and role middleware, request validation, and the error
 * handlers. Services use these with ordinary express.Router() routes.
 */
import { randomUUID } from 'node:crypto'
import express, { type NextFunction, type Request, type RequestHandler, type RequestParamHandler, type Response } from 'express'
import type { CryptoKey } from 'jose'
import { pinoHttp } from 'pino-http'
import type { Role } from '@basketline/contracts'
import { isUuid } from './checks.ts'
import { AppError, badRequest, forbidden, unauthorized } from './errors.ts'
import { healthRoutes, type Health } from './health.ts'
import { createHttpMetrics } from './metrics.ts'
import { verifyAccessToken, type AccessTokenClaims, type EventSender } from './jwt.ts'
import type { Logger } from './logger.ts'

declare global {
  namespace Express {
    interface Request {
      /** Set by authenticate / optionalAuth. */
      auth?: AccessTokenClaims
      /** Set by gatewayCaller. */
      caller?: Caller
    }
  }
}

/**
 * express() with request IDs, request logging, health probes (see health.ts),
 * request metrics at GET /metrics (metrics.ts) and, unless parseJson is false (the gateway streams bodies through), JSON body parsing.
 */
export function createBaseApp({
  name,
  logger,
  health,
  parseJson = true,
}: {
  name: string
  logger: Logger
  health: Health
  parseJson?: boolean
}) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id']
        const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID()
        res.setHeader('x-request-id', id)
        return id
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  )
  const metrics = createHttpMetrics(name)
  // A service's own metrics register here, to be served on its /metrics too.
  app.locals.metrics = metrics.registry
  app.use(metrics.middleware)
  app.use(healthRoutes(name, health))
  app.use(metrics.routes)
  if (parseJson) app.use(express.json({ limit: '100kb' }))
  return app
}

/** The bearer token, or null without an Authorization header. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) throw unauthorized('INVALID_TOKEN', 'Authorization header must be "Bearer <token>"')
  return token
}

async function readToken(req: Request, publicKey: CryptoKey): Promise<AccessTokenClaims | null> {
  const token = bearerToken(req)
  if (!token) return null
  try {
    return await verifyAccessToken(token, publicKey)
  } catch {
    throw unauthorized('INVALID_TOKEN', 'Access token is invalid or expired')
  }
}

/** The tenant_id header when it is a UUID, else null. Only for requests that have no token yet. */
export function tenantHeader(req: Request): string | null {
  const header = req.headers.tenant_id
  return isUuid(header) ? header.toLowerCase() : null
}

/**
 * Requires a valid JWT (verified locally with the public key) and sets
 * req.auth. `checkSession` lets the auth service also check its own session table.
 */
export function authenticate(publicKey: CryptoKey, checkSession?: (claims: AccessTokenClaims) => Promise<void>): RequestHandler {
  return async (req, _res, next) => {
    const claims = await readToken(req, publicKey)
    if (!claims) throw unauthorized('UNAUTHENTICATED', 'A bearer token is required')
    await checkSession?.(claims)
    req.auth = claims
    next()
  }
}

/** Like authenticate, but anonymous requests are allowed (req.auth stays undefined). */
export function optionalAuth(publicKey: CryptoKey): RequestHandler {
  return async (req, _res, next) => {
    const claims = await readToken(req, publicKey)
    if (claims) req.auth = claims
    next()
  }
}

/** An event's sender, as the gateway verified it from the token. */
export type Sender = Omit<EventSender, 'claims'>

/** Who is calling: the tenant, plus the sender for events (an events token). */
export type Caller = Pick<Sender, 'tenantId'> & Partial<Sender>

/**
 * The caller the gateway verified, as JSON. The gateway drops any client-supplied
 * one; only it can reach the services (the NetworkPolicy in deploy/helm), so they
 * trust it instead of verifying the token again.
 */
export const CALLER_HEADER = 'x-basketline-caller'

/** Requires the gateway's caller header and sets req.caller. */
export const gatewayCaller: RequestHandler = (req, _res, next) => {
  let caller: Caller | undefined
  try {
    caller = JSON.parse(String(req.headers[CALLER_HEADER]))
  } catch {}
  if (!isUuid(caller?.tenantId)) throw unauthorized('UNAUTHENTICATED', 'A bearer token is required')
  req.caller = caller
  next()
}

/** Use after authenticate. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) throw forbidden('FORBIDDEN', `Requires role: ${roles.join(' or ')}`)
    next()
  }
}

/**
 * Runs a validator function (returns a list of error messages) against the
 * request body or query string; any errors become a 400 response.
 */
export function validate(validator: (input: any) => string[], source: 'body' | 'query' = 'body'): RequestHandler {
  return (req, _res, next) => {
    const input = source === 'body' ? (req.body ?? {}) : req.query
    const errors = validator(input)
    if (errors.length > 0) throw badRequest('VALIDATION_FAILED', 'Request validation failed', { errors })
    next()
  }
}

/** Use with router.param('someId', uuidParam): rejects non-UUID path IDs with 400 INVALID_ID. */
export const uuidParam: RequestParamHandler = (_req, _res, next, value, name) => {
  next(isUuid(value) ? undefined : badRequest('INVALID_ID', `${name} must be a UUID`))
}

function errorBody(code: string, message: string, requestId: unknown, details?: unknown) {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } }
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(errorBody('NOT_FOUND', `No route for ${req.method} ${req.path}`, req.id))
}

/** Converts thrown errors into JSON responses. Register last. */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    if (error.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(error.retryAfterSeconds))
    res.status(error.status).json(errorBody(error.code, error.message, req.id, error.details))
    return
  }
  const bodyError = error as { type?: string }
  if (bodyError?.type === 'entity.parse.failed') {
    res.status(400).json(errorBody('INVALID_JSON', 'Request body is not valid JSON', req.id))
    return
  }
  if (bodyError?.type === 'entity.too.large') {
    res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', 'Request body is too large', req.id))
    return
  }
  req.log.error({ err: error }, 'unhandled error')
  res.status(500).json(errorBody('INTERNAL', 'An unexpected error occurred', req.id))
}
