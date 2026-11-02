/**
 * The retailer's side of the Basketline integration, through Basketline's public
 * API only, as any retailer's backend:
 *   - onboarding (POST /accounts), which returns the store's tenant and API key;
 *   - shopper tokens for its signed-in customers (POST /auth/shopper-token, API key);
 *   - its sellers, products and campaigns, with the SDK's server entry and the API key.
 */
import { createBasketlineServer, type BasketlineServer } from '@divya2424/basketline-sdk/server'
import { AppError, serviceUnavailable, type Logger } from '@basketline/platform'

export interface OnboardedStore {
  tenantId: string
  name: string
  tier: string
  apiKey: string
  /** The Basketline users onboarding created (its dashboard users), and their password. */
  users: { username: string; role: string }[]
  password: string
}

export function createBasketlineClient({ apiUrl, fetch: doFetch = globalThis.fetch }: { apiUrl: string; fetch?: typeof fetch }) {
  const base = apiUrl.replace(/\/$/, '')

  /** Basketline's client errors pass through (status, code, message); its outages are 503. */
  async function call<T>(path: string, init: { body: object; headers?: Record<string, string> }): Promise<T> {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...init.headers },
        body: JSON.stringify(init.body),
      })
    } catch {
      throw serviceUnavailable('BASKETLINE_UNAVAILABLE', "Can't reach Basketline; try again shortly")
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; details?: unknown } }
    if (res.status >= 500) throw serviceUnavailable('BASKETLINE_UNAVAILABLE', `Basketline answered ${res.status}; try again shortly`)
    if (!res.ok) throw new AppError(res.status, body.error?.code ?? 'BASKETLINE_ERROR', body.error?.message ?? `Basketline answered ${res.status}`, body.error?.details)
    return body as T
  }

  return {
    /** Onboards a store; the API key comes only in this answer. */
    async onboard(input: { name: string; tier: string; sellerManagers?: { username: string; sellerId: string }[] }): Promise<OnboardedStore> {
      const { account, apiKey, users, password } = await call<{
        account: { tenantId: string; name: string; tier: string }
        apiKey: { key: string }
        users: { username: string; role: string }[]
        password: string
      }>('/accounts', { body: input })
      return { tenantId: account.tenantId, name: account.name, tier: account.tier, apiKey: apiKey.key, users, password }
    },

    /** A shopper token for a signed-in customer: Basketline's ID for them, kept from the visitor ID on first use. */
    async shopperToken(input: { tenantId: string; apiKey: string; customerId: string; visitorId?: string; clientType?: 'web' | 'mobile' }) {
      const { tenantId, apiKey, ...body } = input
      return call<{ shopperToken: string; expiresIn: number; userId: string }>('/auth/shopper-token', {
        body,
        headers: { tenant_id: tenantId, authorization: `ApiKey ${apiKey}` },
      })
    },
  }
}

export type BasketlineClient = ReturnType<typeof createBasketlineClient>

/**
 * Sends a store's records to Basketline with the SDK's server entry and the
 * store's API key (apiKeyFor; null: the store isn't connected, nothing is sent).
 * Best effort, like the services' Kafka events: a failure is logged, and the
 * record goes again with its next change (or `cli.ts republish`).
 */
export interface BasketlineSender {
  send(tenantId: string, call: (basketline: BasketlineServer) => Promise<void>): Promise<void>
}

export function createBasketlineSender({
  apiUrl,
  apiKeyFor,
  logger,
  createServer = createBasketlineServer,
}: {
  apiUrl: string
  apiKeyFor: (tenantId: string) => Promise<string | null>
  logger: Logger
  createServer?: typeof createBasketlineServer
}): BasketlineSender {
  // One client per store: each keeps its integration token until shortly before it expires.
  const servers = new Map<string, { apiKey: string; server: BasketlineServer }>()

  return {
    async send(tenantId, call) {
      try {
        const apiKey = await apiKeyFor(tenantId)
        if (!apiKey) {
          logger.warn({ tenantId }, 'store not connected to Basketline; its records are not sent')
          return
        }
        let cached = servers.get(tenantId)
        if (cached?.apiKey !== apiKey) {
          cached = { apiKey, server: createServer({ apiUrl, tenantId, apiKey }) }
          servers.set(tenantId, cached)
        }
        await call(cached.server)
      } catch (error) {
        logger.error({ err: error, tenantId }, 'failed to send records to Basketline; they go again with the next change')
      }
    },
  }
}

export type { BasketlineServer }
