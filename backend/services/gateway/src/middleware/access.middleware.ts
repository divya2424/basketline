/**
 * Coarse route permissions, checked before a request is forwarded. The
 * services check roles again themselves; this stops bad requests early and
 * enforces session revocation, which only the gateway tracks.
 */
import type { RequestHandler } from 'express'
import type { CryptoKey } from 'jose'
import { forbidden, notFound, unauthorized, verifyAccessToken, verifyEventToken, type AccessTokenClaims } from '@ecommerce-analytics/platform'
import type { AccessService } from '../services/access.service.ts'

/** 'events': an access token or a visitor token (anonymous storefront visitors). */
type Access = 'public' | 'optional' | 'authenticated' | 'campaign-manager' | 'events'

/** Who may call what. Returns null for paths the gateway doesn't expose. */
export function accessFor(method: string, path: string): Access | null {
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/v1/auth/register' || path === '/api/v1/auth/login' || path === '/api/v1/auth/visitor') {
    return method === 'POST' ? 'public' : null
  }
  if (path.startsWith('/api/v1/auth/')) return 'authenticated'
  // Tenant onboarding (list and create accounts) is open to anyone, by choice: see the README.
  if (path === '/api/v1/accounts') return read || method === 'POST' ? 'public' : null
  if (path === '/api/v1/analytics/events') return method === 'POST' ? 'events' : null
  // Campaign metrics are for campaign managers, and only their own tenant's (the service reads it from the token).
  if (path.startsWith('/api/v1/ad/')) return read ? 'campaign-manager' : null
  if (path.startsWith('/api/v1/analytics/')) return read ? 'authenticated' : null
  // Catalog reads are public so visitors can browse the store; writes need a campaign manager.
  if (/^\/api\/v1\/(products|campaigns)(\/|$)/.test(path)) return read ? 'optional' : 'campaign-manager'
  return null
}

export function accessMiddleware(publicKey: CryptoKey, access: AccessService): RequestHandler {
  return async (req, _res, next) => {
    if (req.method === 'OPTIONS') return next()
    const rule = accessFor(req.method, req.path)
    if (!rule) throw notFound('NOT_FOUND', `No route for ${req.method} ${req.path}`)

    // Never trust a client-supplied user_id; it is set from the token below.
    delete req.headers.user_id

    let claims: AccessTokenClaims | null = null
    const header = req.headers.authorization
    if (header && rule !== 'public') {
      const [scheme, token] = header.split(' ')
      try {
        if (scheme !== 'Bearer' || !token) throw new Error('bad scheme')
        // A visitor token has no claims to check here; analytics-service verifies it again.
        claims = rule === 'events' ? (await verifyEventToken(token, publicKey)).claims : await verifyAccessToken(token, publicKey)
      } catch {
        throw unauthorized('INVALID_TOKEN', 'Access token is invalid or expired')
      }
      if (claims) await access.assertTokenUsable(claims)
    }
    if (rule === 'events' && !header) throw unauthorized('UNAUTHENTICATED', 'A bearer token (access or visitor) is required')
    if (!claims && (rule === 'authenticated' || rule === 'campaign-manager')) {
      throw unauthorized('UNAUTHENTICATED', 'A bearer token is required')
    }
    if (rule === 'campaign-manager' && claims?.role !== 'campaign-manager') {
      throw forbidden('FORBIDDEN', 'Requires role: campaign-manager')
    }
    if (claims) req.headers.user_id = claims.sub
    next()
  }
}
