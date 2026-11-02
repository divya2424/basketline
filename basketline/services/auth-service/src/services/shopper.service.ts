/**
 * Vendors' API keys and shopper tokens. A vendor's shoppers aren't Basketline
 * users: the vendor's backend vouches for its signed-in customer with its API
 * key, and gets a short-lived shopper token (registered, events only) that it
 * hands to the Basketline SDK in the browser. Each customer is counted as one
 * UUID, set on the first token, to the visitor's UUID when the vendor passes it,
 * so a visitor who signs in stays one person.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { CryptoKey } from 'jose'
import { ANALYTICS_EVENT_TYPE, IDENTITY_TOPIC, type AnalyticsEventPayload } from '@basketline/contracts'
import { isUniqueViolation, isUuid, signIntegrationToken, signShopperToken, unauthorized, type EventBus, type Logger } from '@basketline/platform'
import { withTenant, type Db, type Tx } from '../db/client.ts'
import {
  findActiveApiKey,
  findExternalCustomer,
  insertApiKey,
  insertExternalCustomer,
  isUserIdTaken,
  listApiKeys,
  revokeApiKeys,
} from '../repositories/api-key.repository.ts'

const KEY_PREFIX = 'bl_sk_'
/** The characters of a key kept to tell keys apart (the "bl_sk_" prefix and 6 more). */
const SHOWN_CHARACTERS = KEY_PREFIX.length + 6

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

/**
 * A new key for the tenant, saved in the caller's transaction (onboarding
 * creates the first one with the account). The key is returned only here; only
 * its hash is stored.
 */
export async function newApiKey(tx: Tx, tenantId: string, name: string) {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`
  const saved = await insertApiKey(tx, { id: randomUUID(), tenantId, name, keyHash: hashKey(key), prefix: key.slice(0, SHOWN_CHARACTERS) })
  return { key, prefix: saved.prefix, name: saved.name, createdAt: saved.createdAt }
}

export interface ShopperTokenInput {
  customerId: string
  visitorId?: string
  clientType?: 'web' | 'mobile'
}

export function createShopperService({ db, privateKey, bus, logger }: { db: Db; privateKey: CryptoKey; bus?: EventBus; logger?: Logger }) {
  /** Checks the API key (Authorization: ApiKey <key>) for the tenant. */
  async function checkApiKey(tenantId: string, authorization: string | undefined) {
    const [scheme, key] = (authorization ?? '').split(' ')
    if (scheme !== 'ApiKey' || !key?.startsWith(KEY_PREFIX)) throw unauthorized('INVALID_API_KEY', 'Send the tenant\'s API key as "Authorization: ApiKey <key>"')
    const found = await withTenant(db, tenantId, (tx) => findActiveApiKey(tx, tenantId, hashKey(key)))
    if (!found) throw unauthorized('INVALID_API_KEY', 'The API key is unknown, revoked or of another tenant')
  }

  /**
   * The retailer vouched for a signed-in customer: user_identified on the identity
   * topic (the visitor became this customer). Best effort: the token is issued anyway.
   */
  function recordIdentified(tenantId: string, userId: string, visitorId: string | undefined, clientType: 'web' | 'mobile') {
    if (!bus) return
    const now = new Date().toISOString()
    const payload: AnalyticsEventPayload = {
      eventId: randomUUID(), eventType: 'identity', eventName: 'user_identified', campaignId: null, productId: null, sellerId: null,
      userId, userType: 'registered', clientType, tenantId, pageName: null, featureName: null,
      properties: visitorId && isUuid(visitorId) ? { visitorId: visitorId.toLowerCase() } : {}, timestamp: now, receivedAt: now,
    }
    const envelope = { eventId: payload.eventId, eventType: ANALYTICS_EVENT_TYPE, eventVersion: 1, occurredAt: now, producer: 'auth-service', aggregateId: payload.eventId, aggregateVersion: 1, payload }
    bus.publish([{ topic: IDENTITY_TOPIC, key: userId, envelope }]).catch((error) => logger?.warn({ err: error, tenantId }, 'failed to record user_identified'))
  }

  /** The UUID the customer is counted as: the stored one, else the visitor's (if free), else a new one. */
  async function userIdFor(tenantId: string, customerId: string, visitorId: string | undefined): Promise<string> {
    return withTenant(db, tenantId, async (tx) => {
      const known = await findExternalCustomer(tx, tenantId, customerId)
      if (known) return known
      const candidate = visitorId && isUuid(visitorId) && !(await isUserIdTaken(tx, tenantId, visitorId.toLowerCase())) ? visitorId.toLowerCase() : randomUUID()
      try {
        await insertExternalCustomer(tx, { tenantId, customerId, userId: candidate })
        return candidate
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        // Another request mapped this customer (or claimed the UUID) at the same time.
        return withTenant(db, tenantId, async (again) => (await findExternalCustomer(again, tenantId, customerId)) ?? candidate)
      }
    })
  }

  return {
    /** A new key for the tenant; see newApiKey. */
    createApiKey: (tenantId: string, name: string) => withTenant(db, tenantId, (tx) => newApiKey(tx, tenantId, name)),

    listApiKeys: (tenantId: string) => withTenant(db, tenantId, (tx) => listApiKeys(tx, tenantId)),

    revokeApiKey: (tenantId: string, prefix: string) => withTenant(db, tenantId, (tx) => revokeApiKeys(tx, tenantId, prefix)),

    /** Checks the API key for the tenant, then signs a shopper token. */
    async shopperToken(tenantId: string, authorization: string | undefined, input: ShopperTokenInput) {
      await checkApiKey(tenantId, authorization)
      const userId = await userIdFor(tenantId, input.customerId, input.visitorId)
      const { token, expiresAt } = await signShopperToken(privateKey, { tenantId, userId, client: input.clientType ?? 'web' })
      recordIdentified(tenantId, userId, input.visitorId, input.clientType ?? 'web')
      return { token, expiresAt, userId }
    },

    /** Checks the API key for the tenant, then signs an integration token (reference data, server-side identity). */
    async integrationToken(tenantId: string, authorization: string | undefined) {
      await checkApiKey(tenantId, authorization)
      return signIntegrationToken(privateKey, tenantId)
    },

    /**
     * For the mimic retailer services only (they act as every tenant's backend):
     * an integration token without an API key, behind a secret shared inside the
     * cluster. A real retailer uses its API key.
     */
    internalIntegrationToken: (tenantId: string) => signIntegrationToken(privateKey, tenantId),
  }
}

export type ShopperService = ReturnType<typeof createShopperService>
