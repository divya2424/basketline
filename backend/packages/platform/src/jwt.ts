import { randomUUID } from 'node:crypto'
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from 'jose'
import { ROLES, type Role } from '@ecommerce-analytics/contracts'
import { isUuid } from './checks.ts'

export const JWT_ALGORITHM = 'ES256'
export const JWT_ISSUER = 'ecommerce-analytics-auth'
export const JWT_AUDIENCE = 'ecommerce-analytics-api'
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60
/** Visitor tokens are only accepted by event ingestion: any other API rejects this audience. */
export const VISITOR_AUDIENCE = 'ecommerce-analytics-events'
export const VISITOR_TOKEN_TTL_SECONDS = 30 * 60

export interface AccessTokenClaims {
  sub: string
  sid: string
  role: Role
  /** The user's tenant (UUID). */
  tid: string
  iat: number
  exp: number
}

/** An anonymous storefront visitor: a random ID bound to one tenant. */
export interface VisitorTokenClaims {
  sub: string
  tid: string
  exp: number
}

export function loadPublicKey(pem: string): Promise<CryptoKey> {
  return importSPKI(pem, JWT_ALGORITHM)
}

export function loadPrivateKey(pem: string): Promise<CryptoKey> {
  return importPKCS8(pem, JWT_ALGORITHM)
}

/** Verifies signature, issuer, audience and expiry locally — no call to the auth service. */
export async function verifyAccessToken(token: string, publicKey: CryptoKey): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: [JWT_ALGORITHM],
  })
  const { sub, sid, role, tid, iat, exp } = payload as Partial<AccessTokenClaims>
  if (typeof sub !== 'string' || typeof sid !== 'string' || !isUuid(tid) || typeof iat !== 'number' || typeof exp !== 'number') {
    throw new Error('token is missing required claims')
  }
  if (!ROLES.includes(role as Role)) throw new Error('token has an unknown role')
  return { sub, sid, role: role as Role, tid, iat, exp }
}

export async function verifyVisitorToken(token: string, publicKey: CryptoKey): Promise<VisitorTokenClaims> {
  const { payload } = await jwtVerify(token, publicKey, { issuer: JWT_ISSUER, audience: VISITOR_AUDIENCE, algorithms: [JWT_ALGORITHM] })
  const { sub, tid, exp } = payload as Partial<VisitorTokenClaims>
  if (!isUuid(sub) || !isUuid(tid) || typeof exp !== 'number') throw new Error('token is missing required claims')
  return { sub, tid, exp }
}

/** Who sent an analytics event: a signed-in user (access token) or a visitor (visitor token). */
export interface EventSender {
  tenantId: string
  /** The user's ID, or null for a visitor. */
  userId: string | null
  /** The user or visitor ID, for per-sender limits. */
  subject: string
  /** Set for a user token, so the gateway can check revocation. */
  claims: AccessTokenClaims | null
}

/** Accepts an access token or a visitor token; throws if it is neither. */
export async function verifyEventToken(token: string, publicKey: CryptoKey): Promise<EventSender> {
  try {
    const claims = await verifyAccessToken(token, publicKey)
    return { tenantId: claims.tid, userId: claims.sub, subject: claims.sub, claims }
  } catch {
    const visitor = await verifyVisitorToken(token, publicKey)
    return { tenantId: visitor.tid, userId: null, subject: visitor.sub, claims: null }
  }
}

export async function signVisitorToken(
  privateKey: CryptoKey,
  tenantId: string,
  issuedAt: Date = new Date(),
  ttlSeconds = VISITOR_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(issuedAt.getTime() / 1000)
  const exp = iat + ttlSeconds
  const token = await new SignJWT({ tid: tenantId })
    .setProtectedHeader({ alg: JWT_ALGORITHM, typ: 'JWT' })
    .setSubject(randomUUID())
    .setIssuer(JWT_ISSUER)
    .setAudience(VISITOR_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey)
  return { token, expiresAt: new Date(exp * 1000) }
}

export async function signAccessToken(
  privateKey: CryptoKey,
  claims: { sub: string; sid: string; role: Role; tid: string },
  issuedAt: Date = new Date(),
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(issuedAt.getTime() / 1000)
  const exp = iat + ttlSeconds
  const token = await new SignJWT({ sid: claims.sid, role: claims.role, tid: claims.tid })
    .setProtectedHeader({ alg: JWT_ALGORITHM, typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey)
  return { token, expiresAt: new Date(exp * 1000) }
}
