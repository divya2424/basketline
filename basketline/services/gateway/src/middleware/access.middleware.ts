/**
 * Route permissions, checked before a request is forwarded. The gateway is the
 * only place tokens are verified: it sets req.caller, which the proxy passes on
 * in CALLER_HEADER (proxy.routes.ts), and ingestion and insights trust it (only
 * the gateway can reach them). It also enforces session revocation, which only it tracks.
 */
import type { RequestHandler } from 'express'
import type { CryptoKey } from 'jose'
import {
  forbidden,
  isIntegrationToken,
  isUuid,
  notFound,
  unauthorized,
  verifyAccessToken,
  verifyEventToken,
  verifyIntegrationToken,
  type AccessTokenClaims,
  type Caller,
} from '@basketline/platform'
import type { AccessService } from '../services/access.service.ts'

/**
 * 'events': an access token, or an events-only token: a visitor's, or a vendor's shopper's.
 * 'results': a user's access token, or a store's backend's integration token.
 */
type Access = 'public' | 'authenticated' | 'campaign-manager' | 'events' | 'integration' | 'results'

/** Who may call what. Returns null for paths the gateway doesn't expose. */
export function accessFor(method: string, path: string): Access | null {
  const read = method === 'GET' || method === 'HEAD'
  // shopper-token and integration-token: a store's backend, with its API key (auth-service checks it).
  if (['/api/v1/auth/login', '/api/v1/auth/visitor', '/api/v1/auth/shopper-token', '/api/v1/auth/integration-token'].includes(path)) {
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
  // The tenant's campaign list: its users, only their own tenant's.
  if (path === '/api/v1/ad/campaigns') return read ? 'authenticated' : null
  // A campaign's metrics and results per product: also a store's backend, for its sellers' portal.
  if (path.startsWith('/api/v1/ad/')) return read ? 'results' : null
  // Reference data and server-side identity from a store's backend, with an integration token.
  if (path.startsWith('/api/v1/retail/')) return method === 'POST' ? 'integration' : null
  if (path.startsWith('/api/v1/analytics/')) return read ? 'authenticated' : null
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
    let caller: Caller | null = null
    const header = req.headers.authorization
    if (header && rule !== 'public') {
      const [scheme, token] = header.split(' ')
      try {
        if (scheme !== 'Bearer' || !token) throw new Error('bad scheme')
        if (rule === 'integration') {
          // A store's backend: no user, only its tenant.
          eventsTenant = (await verifyIntegrationToken(token, publicKey)).tid
        } else if (rule === 'events') {
          // A visitor's or shopper's token has no claims to check here.
          const { claims: senderClaims, ...sender } = await verifyEventToken(token, publicKey)
          claims = senderClaims
          eventsTenant = sender.tenantId
          caller = sender
        } else if (rule === 'results' && isIntegrationToken(token)) {
          // A store's backend; any other token must be a user's access token.
          eventsTenant = (await verifyIntegrationToken(token, publicKey)).tid
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
    if (!claims && (rule === 'authenticated' || rule === 'campaign-manager' || (rule === 'results' && !eventsTenant))) {
      throw unauthorized('UNAUTHENTICATED', 'A bearer token is required')
    }
    if (rule === 'campaign-manager' && claims?.role !== 'campaign-manager') {
      throw forbidden('FORBIDDEN', 'Requires role: campaign-manager')
    }
    const origin = req.headers.origin
    if (origin && !corsOrigins.includes(origin)) {
      // The visitor-token request names its tenant in the header; an events batch's is its token's.
      const tenant = req.path === '/api/v1/auth/visitor' ? req.headers.tenant_id : rule === 'events' ? (eventsTenant ?? claims?.tid) : undefined
      if (isUuid(tenant)) await access.assertOriginAllowed(tenant, origin)
    }
    if (claims) req.headers.user_id = claims.sub
    caller ??= eventsTenant ? { tenantId: eventsTenant } : claims ? { tenantId: claims.tid } : null
    if (caller) req.caller = caller
    next()
  }
}
