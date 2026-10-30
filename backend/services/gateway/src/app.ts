import { createHash } from 'node:crypto'
import cors, { type CorsOptions } from 'cors'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import type { CryptoKey } from 'jose'
import { createBaseApp, createHealth, errorHandler, notFoundHandler, pingDb, type Health, type Logger } from '@basketline/platform'
import type { Db } from './db/client.ts'
import { accessMiddleware } from './middleware/access.middleware.ts'
import { proxyRoutes, type ServiceUrls } from './routes/proxy.routes.ts'
import { createAccessService } from './services/access.service.ts'

export interface GatewayDeps {
  db: Db
  logger: Logger
  publicKey: CryptoKey
  services: ServiceUrls
  corsOrigins: string[]
  /** Requests per minute per IP (default 300). */
  rateLimitPerMinute?: number
  /** Event ingestion requests per minute per IP, within rateLimitPerMinute (default 120). */
  eventsRateLimitPerMinute?: number
  /** Visitor tokens issued per minute per IP (default 10): each is a fresh anonymous identity. */
  visitorRateLimitPerMinute?: number
  /** Shopper tokens per minute per API key (default 600): a vendor's backend calls from few IPs for all its shoppers. */
  shopperTokenRateLimitPerMinute?: number
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

const MAX_BODY_BYTES = 100 * 1024
/**
 * What the Basketline SDK calls from vendors' sites: any origin may call them.
 * They take bearer tokens, never cookies, so a page on another origin gains
 * nothing it couldn't do with a script. Every other route keeps CORS_ORIGINS.
 */
const SDK_PATHS = new Set(['/api/v1/auth/visitor', '/api/v1/analytics/events'])
const SHOPPER_TOKEN_PATH = '/api/v1/auth/shopper-token'

export function buildGateway({
  db,
  logger,
  publicKey,
  services,
  corsOrigins,
  rateLimitPerMinute = 300,
  eventsRateLimitPerMinute = 120,
  visitorRateLimitPerMinute = 10,
  shopperTokenRateLimitPerMinute = 600,
  health = createHealth({ started: true }),
}: GatewayDeps) {
  health.addCheck('database', () => pingDb(db))
  const access = createAccessService({ db, logger })
  // Bodies are streamed to the services untouched, so the gateway doesn't parse JSON.
  const app = createBaseApp({ name: 'gateway', logger, health, parseJson: false })

  const corsOptions: CorsOptions = {
    // User-Agent: axios sets it on every request, and Firefox includes it in the preflight.
    allowedHeaders: ['Authorization', 'Content-Type', 'tenant_id', 'user_id', 'x-request-id', 'User-Agent'],
    exposedHeaders: ['x-request-id', 'Retry-After'],
    maxAge: 600,
  }
  app.use(cors((req, callback) => callback(null, { ...corsOptions, origin: SDK_PATHS.has(req.url?.split('?')[0] ?? '') ? true : corsOrigins })))
  // Per IP, except shopper tokens: a vendor's backend asks for all its shoppers from a few IPs, so they're limited per API key.
  app.use(rateLimit({ windowMs: 60_000, limit: rateLimitPerMinute, standardHeaders: 'draft-8', legacyHeaders: false, skip: (req) => req.path === SHOPPER_TOKEN_PATH }))
  app.use(
    SHOPPER_TOKEN_PATH,
    rateLimit({
      windowMs: 60_000,
      limit: shopperTokenRateLimitPerMinute,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      // A hash, so the key itself isn't kept in memory; requests without one share a bucket per
      // IP (an IPv6 address by its /56, so a client can't get around it by changing addresses).
      keyGenerator: (req) => createHash('sha256').update(req.headers.authorization ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`).digest('hex'),
    }),
  )
  app.use('/api/v1/analytics/events', rateLimit({ windowMs: 60_000, limit: Math.min(eventsRateLimitPerMinute, rateLimitPerMinute), standardHeaders: 'draft-8', legacyHeaders: false }))
  app.use('/api/v1/auth/visitor', rateLimit({ windowMs: 60_000, limit: Math.min(visitorRateLimitPerMinute, rateLimitPerMinute), standardHeaders: 'draft-8', legacyHeaders: false }))
  app.use((req, res, next) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large', requestId: req.id } })
      return
    }
    next()
  })
  app.use(accessMiddleware(publicKey, access, corsOrigins))
  app.use(...proxyRoutes(services, logger))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return { app, access }
}
