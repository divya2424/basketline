/**
 * Coarse route permissions, checked before a request is forwarded. The
 * services check roles again themselves; this stops bad requests early and
 * enforces session revocation, which only the gateway tracks.
 */
import type { RequestHandler } from 'express'
import type { CryptoKey } from 'jose'
import { forbidden, isUuid, notFound, unauthorized, verifyAccessToken, verifyEventToken, verifyIntegrationToken, type AccessTokenClaims } from '@basketline/platform'
import type { AccessService } from '../services/access.service.ts'

/** 'events': an access token, or an events-only token: a visitor's, or a vendor's shopper's. */
type Access = 'public' | 'optional' | 'authenticated' | 'campaign-manager' | 'metrics-reader' | 'events' | 'integration'

/** Who may call what. Returns null for paths the gateway doesn't expose. */
export function accessFor(method: string, path: string): Access | null {
  const read = method === 'GET' || method === 'HEAD'
  // shopper-token and integration-token: a vendor's backend, with its API key (auth-service checks it).
  if (['/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/auth/visitor', '/api/v1/auth/shopper-token', '/api/v1/auth/integration-token'].includes(path)) {
    return method === 'POST' ? 'public' : null
  }
  // A tenant's API keys and allowed websites: its campaign managers only.
  if (path === '/api/v1/auth/api-keys' || path.startsWith('/api/v1/auth/api-keys/') || path === '/api/v1/auth/allowed-origins') return 'campaign-manager'
  if (path.startsWith('/api/v1/auth/')) return 'authenticated'
  // Tenant onboarding (list and create accounts) is open to anyone, by choice: see the README.
  if (path === '/api/v1/accounts') return read || method === 'POST' ? 'public' : null
  // Deleting a tenant: open like onboarding, by choice (its name must be typed again).
  if (/^\/api\/v1\/accounts\/[^/]+$/.test(path)) return method === 'DELETE' ? 'public' : null
  if (path === '/api/v1/analytics/events') return method === 'POST' ? 'events' : null
  // Campaign metrics: campaign managers (every seller) and seller-managers (their own seller, which
  // analytics-service checks), only their own tenant's (the service reads it from the token).
  if (path.startsWith('/api/v1/ad/')) return read ? 'metrics-reader' : null
  // Reference data and server-side identity from a retailer's backend, with an integration token.
  if (path.startsWith('/api/v1/retail/')) return method === 'POST' ? 'integration' : null
  // The tenant's sellers: public, like the catalog.
  if (path === '/api/v1/sellers') return read ? 'optional' : null
  if (path.startsWith('/api/v1/analytics/')) return read ? 'authenticated' : null
  // Catalog reads are public so visitors can browse the store; writes need a campaign manager.
  if (/^\/api\/v1\/(products|campaigns)(\/|$)/.test(path)) return read ? 'optional' : 'campaign-manager'
  return null
}

/**
 * corsOrigins: Basketline's own apps, which may send any tenant's events. Any
 * other browser page (it sends an Origin header) must be one of the tenant's
 * allowed websites, if it lists any. Requests without an Origin (servers,
 * mobile apps) aren't checked: the rate limits cover them.
 */
export function accessMiddleware(publicKey: CryptoKey, access: AccessService, corsOrigins: string[] = []): RequestHandler {
  return async (req, _res, next) => {
    if (req.method === 'OPTIONS') return next()
    const rule = accessFor(req.method, req.path)
    if (!rule) throw notFound('NOT_FOUND', `No route for ${req.method} ${req.path}`)

    // Never trust a client-supplied user_id; it is set from the token below.
    delete req.headers.user_id

    let claims: AccessTokenClaims | null = null
    let eventsTenant: string | null = null
    const header = req.headers.authorization
    if (header && rule !== 'public') {
      const [scheme, token] = header.split(' ')
      try {
        if (scheme !== 'Bearer' || !token) throw new Error('bad scheme')
        if (rule === 'integration') {
          // A retailer's backend: no user, only its tenant; analytics-service verifies it again.
          eventsTenant = (await verifyIntegrationToken(token, publicKey)).tid
        } else if (rule === 'events') {
          // A visitor's or shopper's token has no claims to check here; analytics-service verifies it again.
          const sender = await verifyEventToken(token, publicKey)
          claims = sender.claims
          eventsTenant = sender.tenantId
        } else {
          claims = await verifyAccessToken(token, publicKey)
        }
      } catch {
        throw unauthorized('INVALID_TOKEN', 'Access token is invalid or expired')
      }
      if (claims) await access.assertTokenUsable(claims)
      else if (eventsTenant) await access.assertTenantActive(eventsTenant)
    }
    if (rule === 'events' && !header) throw unauthorized('UNAUTHENTICATED', 'A bearer token (access or visitor) is required')
    if (rule === 'integration' && !header) throw unauthorized('UNAUTHENTICATED', 'An integration token is required (POST /api/v1/auth/integration-token with your API key)')
    if (!claims && (rule === 'authenticated' || rule === 'campaign-manager' || rule === 'metrics-reader')) {
      throw unauthorized('UNAUTHENTICATED', 'A bearer token is required')
    }
    if (rule === 'campaign-manager' && claims?.role !== 'campaign-manager') {
      throw forbidden('FORBIDDEN', 'Requires role: campaign-manager')
    }
    if (rule === 'metrics-reader' && claims?.role !== 'campaign-manager' && claims?.role !== 'seller-manager') {
      throw forbidden('FORBIDDEN', 'Requires role: campaign-manager or seller-manager')
    }
    const origin = req.headers.origin
    if (origin && !corsOrigins.includes(origin)) {
      // The visitor-token request names its tenant in the header; an events batch's is its token's.
      const tenant = req.path === '/api/v1/auth/visitor' ? req.headers.tenant_id : rule === 'events' ? (eventsTenant ?? claims?.tid) : undefined
      if (isUuid(tenant)) await access.assertOriginAllowed(tenant, origin)
    }
    if (claims) req.headers.user_id = claims.sub
    next()
  }
}
