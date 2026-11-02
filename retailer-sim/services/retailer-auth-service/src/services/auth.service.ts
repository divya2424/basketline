/**
 * The store's own sign-in. A customer also gets a Basketline shopper token: the
 * store vouches for them with its API key (POST /auth/shopper-token), and the
 * storefront hands it to the Basketline SDK, so their events count as one
 * registered person. Basketline being down never stops anyone from signing in.
 */
import type { CryptoKey } from 'jose'
import { forbidden, notFound, serviceUnavailable, unauthorized, type Logger } from '@basketline/platform'
import { openSecret, RETAILER_TOKEN_TTL_SECONDS, signRetailerToken, type BasketlineClient, type RetailerClaims } from '@retailer-sim/shared'
import type { Db } from '../db/client.ts'
import { findStore, type Store } from '../repositories/store.repository.ts'
import { findUserByUsername } from '../repositories/user.repository.ts'
import type { LoginInput, ShopperTokenInput } from '../validators/retailer.validator.ts'
import { getDummyHash, verifyPassword } from './password.ts'

export function createAuthService({
  db,
  privateKey,
  basketline,
  secretsKey,
  logger,
}: {
  db: Db
  privateKey: CryptoKey
  basketline: BasketlineClient
  secretsKey: string
  logger: Logger
}) {
  async function requireStore(tenantId: string): Promise<Store> {
    const store = await findStore(db, tenantId)
    if (!store) throw notFound('STORE_NOT_FOUND', 'No such store')
    return store
  }

  /** Null when Basketline can't be reached: the customer is signed in all the same. */
  async function shopperTokenFor(store: Store, customerId: string, input: ShopperTokenInput) {
    try {
      const apiKey = openSecret(store.sealedApiKey, secretsKey)
      return await basketline.shopperToken({ tenantId: store.tenantId, apiKey, customerId, visitorId: input.visitorId, clientType: input.clientType ?? 'web' })
    } catch (error) {
      logger.warn({ err: error, tenantId: store.tenantId }, 'no Basketline shopper token; the customer counts as a visitor')
      return null
    }
  }

  return {
    async login(tenantId: string, input: LoginInput) {
      const store = await requireStore(tenantId)
      const user = await findUserByUsername(db, tenantId, input.username)
      // Verify against a dummy hash for unknown users so timing doesn't reveal which names exist.
      const valid = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), input.password)
      if (!user || !valid) throw unauthorized('INVALID_CREDENTIALS', 'Invalid username or password')
      const { token, expiresAt } = await signRetailerToken(privateKey, { userId: user.id, tenantId, role: user.role })
      return {
        accessToken: token,
        tokenType: 'Bearer',
        expiresIn: RETAILER_TOKEN_TTL_SECONDS,
        user: { id: user.id, username: user.username, role: user.role },
        session: { expiresAt: expiresAt.toISOString() },
        basketline: user.role === 'customer' ? await shopperTokenFor(store, user.id, input) : null,
      }
    },

    /** A fresh shopper token for a signed-in customer (the SDK asks before the last one expires). */
    async shopperToken(claims: RetailerClaims, input: ShopperTokenInput) {
      if (claims.role !== 'customer') throw forbidden('FORBIDDEN', 'Shopper tokens are for customers')
      const token = await shopperTokenFor(await requireStore(claims.tid), claims.sub, input)
      if (!token) throw serviceUnavailable('BASKETLINE_UNAVAILABLE', 'Basketline is unavailable; try again shortly')
      return token
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
