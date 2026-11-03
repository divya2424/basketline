/**
 * The retailer's own sign-in: tokens from retailer-auth-service, signed with the
 * retailer's key (not Basketline's), for its customers, staff and sellers. Its services
 * verify them locally. Basketline never sees them: it gets shopper tokens,
 * which the retailer's backend asks for with its API key.
 */
import type { RequestHandler } from 'express'
import { jwtVerify, SignJWT, type CryptoKey } from 'jose'
import { bearerToken, forbidden, isUuid, unauthorized } from '@basketline/platform'

/** A seller signs in to the marketplace's seller portal to run its own campaigns. */
export const RETAILER_ROLES = ['customer', 'staff', 'seller'] as const
export type RetailerRole = (typeof RETAILER_ROLES)[number]

const ALGORITHM = 'ES256'
const ISSUER = 'retailer-auth'
const AUDIENCE = 'retailer-api'
export const RETAILER_TOKEN_TTL_SECONDS = 30 * 60

export interface RetailerClaims {
  /** The user (UUID). */
  sub: string
  /** The store's Basketline tenant (UUID). */
  tid: string
  role: RetailerRole
  /** A seller's seller ID (UUID): the seller they act for. */
  sel?: string
  exp: number
}

declare global {
  namespace Express {
    interface Request {
      /** The retailer's signed-in user, set by retailerAuth. */
      retailer?: RetailerClaims
    }
  }
}

export async function signRetailerToken(
  privateKey: CryptoKey,
  { userId, tenantId, role, sellerId }: { userId: string; tenantId: string; role: RetailerRole; sellerId?: string | null },
  ttlSeconds = RETAILER_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ttlSeconds
  const token = await new SignJWT({ tid: tenantId, role, ...(sellerId ? { sel: sellerId } : {}) })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey)
  return { token, expiresAt: new Date(exp * 1000) }
}

export async function verifyRetailerToken(token: string, publicKey: CryptoKey): Promise<RetailerClaims> {
  const { payload } = await jwtVerify(token, publicKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: [ALGORITHM] })
  const { sub, tid, role, sel, exp } = payload as Partial<RetailerClaims>
  if (!isUuid(sub) || !isUuid(tid) || typeof exp !== 'number' || !RETAILER_ROLES.includes(role as RetailerRole)) throw new Error('token is missing required claims')
  if (role === 'seller' && !isUuid(sel)) throw new Error("a seller's token needs its seller (sel)")
  return { sub, tid, role: role as RetailerRole, ...(role === 'seller' ? { sel } : {}), exp }
}

/** Sets req.retailer from the bearer token. Optional: anonymous requests pass (an invalid token never does). */
export function retailerAuth(publicKey: CryptoKey, { optional = false } = {}): RequestHandler {
  return async (req, _res, next) => {
    const token = bearerToken(req)
    if (!token) {
      if (optional) return next()
      throw unauthorized('UNAUTHENTICATED', 'A bearer token is required')
    }
    try {
      req.retailer = await verifyRetailerToken(token, publicKey)
    } catch {
      throw unauthorized('INVALID_TOKEN', 'Token is invalid or expired')
    }
    next()
  }
}

/** Use after retailerAuth: the store's staff only. */
export const requireStaff: RequestHandler = (req, _res, next) => {
  if (req.retailer?.role !== 'staff') throw forbidden('FORBIDDEN', 'Requires the staff role')
  next()
}

/** Use after retailerAuth: the store's staff, or a seller (whom the service then limits to its own records). */
export const requireStaffOrSeller: RequestHandler = (req, _res, next) => {
  if (req.retailer?.role !== 'staff' && req.retailer?.role !== 'seller') throw forbidden('FORBIDDEN', 'Requires the staff or seller role')
  next()
}
