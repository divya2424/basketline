import { randomUUID } from 'node:crypto'
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from 'jose'
import { CLIENT_TYPES, ROLES, type ClientType, type Role, type UserType } from '@basketline/contracts'
import { isUuid } from './checks.ts'

export const JWT_ALGORITHM = 'ES256'
export const JWT_ISSUER = 'basketline-auth'
export const JWT_AUDIENCE = 'basketline-api'
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60
/**
 * Events-only tokens (visitor and shopper tokens) are only accepted by event
 * ingestion: any other API rejects this audience.
 */
export const VISITOR_AUDIENCE = 'basketline-events'
export const VISITOR_TOKEN_TTL_SECONDS = 30 * 60
export const SHOPPER_TOKEN_TTL_SECONDS = 30 * 60
/**
 * Integration tokens: a retailer's backend exchanges its API key for one
 * (POST /auth/integration-token) to send reference data (catalog, campaigns,
 * server-side identity). Only those APIs accept this audience.
 */
export const INTEGRATION_AUDIENCE = 'basketline-integration'
export const INTEGRATION_TOKEN_TTL_SECONDS = 15 * 60

export interface AccessTokenClaims {
  sub: string
  sid: string
  role: Role
  /** The user's tenant (UUID). */
  tid: string
  /** The app the user signed in with. */
  client: ClientType
  /** A seller-manager's seller (UUID); absent for other roles. */
  sel?: string
  iat: number
  exp: number
}

/** A retailer's backend, for reference data: the tenant only. */
export interface IntegrationTokenClaims {
  tid: string
  exp: number
}

/**
 * An events-only token, bound to one tenant:
 *   visitor: someone not signed in; sub is the client's UUID for them (or a random one).
 *   shopper: a vendor's signed-in customer, vouched for by the vendor's backend with
 *            its API key (POST /auth/shopper-token); sub is the UUID Basketline keeps for them.
 */
export interface VisitorTokenClaims {
  sub: string
  tid: string
  client: ClientType
  kind: 'visitor' | 'shopper'
  exp: number
}

/** Tokens issued before the client claim existed (they last 30 minutes) were all from the web app. */
function clientClaim(value: unknown): ClientType {
  if (value === undefined) return 'web'
  if (!CLIENT_TYPES.includes(value as ClientType)) throw new Error('token has an unknown client')
  return value as ClientType
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
  const { sub, sid, role, tid, client, sel, iat, exp } = payload as Partial<AccessTokenClaims>
  if (typeof sub !== 'string' || typeof sid !== 'string' || !isUuid(tid) || typeof iat !== 'number' || typeof exp !== 'number') {
    throw new Error('token is missing required claims')
  }
  if (!ROLES.includes(role as Role)) throw new Error('token has an unknown role')
  if (role === 'seller-manager' && !isUuid(sel)) throw new Error("a seller-manager's token needs its seller")
  return { sub, sid, role: role as Role, tid, client: clientClaim(client), ...(role === 'seller-manager' ? { sel: sel! } : {}), iat, exp }
}

export async function verifyIntegrationToken(token: string, publicKey: CryptoKey): Promise<IntegrationTokenClaims> {
  const { payload } = await jwtVerify(token, publicKey, { issuer: JWT_ISSUER, audience: INTEGRATION_AUDIENCE, algorithms: [JWT_ALGORITHM] })
  const { tid, exp } = payload as Partial<IntegrationTokenClaims>
  if (!isUuid(tid) || typeof exp !== 'number') throw new Error('token is missing required claims')
  return { tid, exp }
}

export async function signIntegrationToken(
  privateKey: CryptoKey,
  tenantId: string,
  issuedAt: Date = new Date(),
  ttlSeconds = INTEGRATION_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(issuedAt.getTime() / 1000)
  const exp = iat + ttlSeconds
  const token = await new SignJWT({ tid: tenantId })
    .setProtectedHeader({ alg: JWT_ALGORITHM, typ: 'JWT' })
    .setSubject(tenantId)
    .setIssuer(JWT_ISSUER)
    .setAudience(INTEGRATION_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey)
  return { token, expiresAt: new Date(exp * 1000) }
}

export async function verifyVisitorToken(token: string, publicKey: CryptoKey): Promise<VisitorTokenClaims> {
  const { payload } = await jwtVerify(token, publicKey, { issuer: JWT_ISSUER, audience: VISITOR_AUDIENCE, algorithms: [JWT_ALGORITHM] })
  const { sub, tid, client, kind, exp } = payload as Partial<VisitorTokenClaims>
  if (!isUuid(sub) || !isUuid(tid) || typeof exp !== 'number') throw new Error('token is missing required claims')
  return { sub, tid, client: clientClaim(client), kind: kind === 'shopper' ? 'shopper' : 'visitor', exp }
}

/** Who sent an analytics event: a signed-in user (access or shopper token) or a visitor (visitor token). */
export interface EventSender {
  tenantId: string
  /** The person: the registered user's ID, or the visitor's UUID (the token's sub). */
  userId: string
  userType: UserType
  clientType: ClientType
  /** Set for a Basketline user's access token, so the gateway can check revocation. */
  claims: AccessTokenClaims | null
}

/** Accepts an access, shopper or visitor token; throws if it is none of them. A shopper is registered. */
export async function verifyEventToken(token: string, publicKey: CryptoKey): Promise<EventSender> {
  try {
    const claims = await verifyAccessToken(token, publicKey)
    return { tenantId: claims.tid, userId: claims.sub, userType: 'registered', clientType: claims.client, claims }
  } catch {
    const events = await verifyVisitorToken(token, publicKey)
    const userType = events.kind === 'shopper' ? 'registered' : 'visitor'
    return { tenantId: events.tid, userId: events.sub, userType, clientType: events.client, claims: null }
  }
}

/** visitorId: the client's UUID for the visitor, kept when the visitor registers, so its events count as one customer. */
export async function signVisitorToken(
  privateKey: CryptoKey,
  { tenantId, visitorId = randomUUID(), client = 'web' }: { tenantId: string; visitorId?: string; client?: ClientType },
  issuedAt: Date = new Date(),
  ttlSeconds = VISITOR_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: Date }> {
  return signEventsToken(privateKey, { tenantId, userId: visitorId, client, kind: 'visitor' }, issuedAt, ttlSeconds)
}

/** A vendor's signed-in customer (registered), for events only; userId is the UUID Basketline keeps for them. */
export async function signShopperToken(
  privateKey: CryptoKey,
  { tenantId, userId, client = 'web' }: { tenantId: string; userId: string; client?: ClientType },
  issuedAt: Date = new Date(),
  ttlSeconds = SHOPPER_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: Date }> {
  return signEventsToken(privateKey, { tenantId, userId, client, kind: 'shopper' }, issuedAt, ttlSeconds)
}

async function signEventsToken(
  privateKey: CryptoKey,
  { tenantId, userId, client, kind }: { tenantId: string; userId: string; client: ClientType; kind: VisitorTokenClaims['kind'] },
  issuedAt: Date,
  ttlSeconds: number,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(issuedAt.getTime() / 1000)
  const exp = iat + ttlSeconds
  const token = await new SignJWT({ tid: tenantId, client, kind })
    .setProtectedHeader({ alg: JWT_ALGORITHM, typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(VISITOR_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey)
  return { token, expiresAt: new Date(exp * 1000) }
}

export async function signAccessToken(
  privateKey: CryptoKey,
  claims: { sub: string; sid: string; role: Role; tid: string; client: ClientType; sel?: string },
  issuedAt: Date = new Date(),
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(issuedAt.getTime() / 1000)
  const exp = iat + ttlSeconds
  const token = await new SignJWT({ sid: claims.sid, role: claims.role, tid: claims.tid, client: claims.client, ...(claims.sel ? { sel: claims.sel } : {}) })
    .setProtectedHeader({ alg: JWT_ALGORITHM, typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey)
  return { token, expiresAt: new Date(exp * 1000) }
}
