/**
 * The retailer's side of the Basketline integration, through Basketline's public
 * API only, as any retailer's backend:
 *   - onboarding (POST /accounts), which returns the store's tenant and API key;
 *   - shopper tokens for its signed-in customers (POST /auth/shopper-token, API key);
 *   - its sellers, products and campaigns, and its sellers' campaign results, with
 *     the API key (createStoreApi). The Basketline SDK is only the storefront's: it
 *     captures shoppers' events.
 */
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
    async onboard(input: { name: string; tier: string }): Promise<OnboardedStore> {
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

/** A record's full state, with when it is from (default now): Basketline keeps the newest. */
type Update = Record<string, unknown> & { updatedAt?: string | Date }
type OneOrMany = Update | Update[]

/** A campaign's results for one product (GET /ad/{campaignId}/products). */
export interface CampaignProductResult {
  productId: string
  name: string | null
  category: string | null
  price: number | null
  impressions: number
  clicks: number
  ctr: number
  addToCarts: number
  clickToBasket: number
}

/** A campaign metric's answer (GET /ad/{campaignId}/{metric}): its total, the customers behind it, and its columns (e.g. total_converted_sessions). */
export interface CampaignMetric {
  count: number
  customers?: number
  [column: string]: unknown
}

export type CampaignMetricName = 'impressions' | 'clicks' | 'clickToBasket' | 'uniqueCustomers' | 'sessions'

/** Updates per request (the retail API's limit). */
const MAX_PER_REQUEST = 500
/** Integration tokens last 15 minutes; a new one is fetched a minute before. */
const RENEW_BEFORE_MS = 60_000

/**
 * One store's calls to Basketline's API with its API key, which is traded for
 * an integration token (POST /auth/integration-token), reused until shortly
 * before it expires; a 401 gets a fresh one once. Records go to the retail API
 * (POST /retail/catalog, /retail/campaigns, /retail/identity) as full-state
 * updates; results come from GET /ad/{campaignId}/products. Failures throw.
 */
export function createStoreApi({ apiUrl, tenantId, apiKey, fetch: doFetch = globalThis.fetch }: { apiUrl: string; tenantId: string; apiKey: string; fetch?: typeof fetch }) {
  const base = apiUrl.replace(/\/$/, '')
  let token: { value: Promise<string>; renewAt: number } | undefined

  async function fetchToken(): Promise<{ value: string; renewAt: number }> {
    const res = await doFetch(`${base}/auth/integration-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', tenant_id: tenantId, authorization: `ApiKey ${apiKey}` },
      body: '{}',
    })
    if (!res.ok) throw new Error(`Basketline refused the API key (${res.status})`)
    const { integrationToken, expiresIn } = (await res.json()) as { integrationToken: string; expiresIn: number }
    return { value: integrationToken, renewAt: Date.now() + expiresIn * 1000 - RENEW_BEFORE_MS }
  }

  function integrationToken(fresh: boolean): Promise<string> {
    if (!token || fresh || token.renewAt <= Date.now()) {
      const pending = fetchToken()
      const entry = { value: pending.then((t) => t.value), renewAt: Infinity }
      token = entry
      pending.then((t) => (entry.renewAt = t.renewAt), () => token === entry && (token = undefined))
    }
    return token.value
  }

  async function request(path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await integrationToken(attempt > 0)}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (res.status === 401 && attempt === 0) continue
      if (!res.ok) throw new Error(`Basketline answered ${res.status} to ${path}: ${await res.text()}`)
      return res.json()
    }
  }

  /** Each record as an update of the named event, in requests of up to 500. */
  async function send(endpoint: 'catalog' | 'campaigns' | 'identity', eventName: string, records: OneOrMany) {
    const events = [records].flat().map(({ updatedAt, ...data }) => ({ eventName, updatedAt: new Date(updatedAt ?? Date.now()).toISOString(), data }))
    for (let i = 0; i < events.length; i += MAX_PER_REQUEST) await request(`/retail/${endpoint}`, { events: events.slice(i, i + MAX_PER_REQUEST) })
  }
  const ids = (key: string, values: string | string[]) => [values].flat().map((value) => ({ [key]: value }))
  type Scope = { campaignId: string; storeId?: string; from?: string; to?: string }
  const query = (params: Record<string, string | undefined>) =>
    new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined))

  return {
    catalog: {
      upsertSeller: (sellers: OneOrMany) => send('catalog', 'seller_upserted', sellers),
      upsertProduct: (products: OneOrMany) => send('catalog', 'product_upserted', products),
      removeProduct: (productIds: string | string[]) => send('catalog', 'product_removed', ids('productId', productIds)),
    },
    campaigns: {
      /** A campaign with its seller, placement and product IDs (its store is its seller). */
      upsert: (campaigns: OneOrMany) => send('campaigns', 'campaign_upserted', campaigns),
      remove: (campaignIds: string | string[]) => send('campaigns', 'campaign_removed', ids('campaignId', campaignIds)),
      /** Products added to a campaign, with their name, price, category and seller. */
      addProducts: (products: OneOrMany) => send('campaigns', 'campaign_product_added', products),
      removeProducts: (products: OneOrMany) => send('campaigns', 'campaign_product_removed', products),
    },
    identity: {
      identified: (shoppers: OneOrMany) => send('identity', 'user_identified', shoppers),
      deleteUser: (userIds: string | string[]) => send('identity', 'user_deleted', ids('userId', userIds)),
    },
    insights: {
      /** A campaign's results per product over [from, to) (default the last 30 days), for one store (seller) or all. */
      async campaignProducts({ campaignId, storeId, from, to }: Scope): Promise<CampaignProductResult[]> {
        return ((await request(`/ad/${campaignId}/products?${query({ storeId, from, to })}`)) as { items: CampaignProductResult[] }).items
      },
      /** One of a campaign's metrics over the same period, for one store (seller) or all. */
      campaignMetric: ({ campaignId, metric, storeId, from, to }: Scope & { metric: CampaignMetricName }) =>
        request(`/ad/${campaignId}/${metric}?${query({ storeId, from, to })}`) as Promise<CampaignMetric>,
    },
  }
}

export type BasketlineServer = ReturnType<typeof createStoreApi>

/**
 * Sends a store's records to Basketline with the store's API key (createStoreApi) (apiKeyFor; null: the store isn't connected, nothing is sent).
 * Best effort, like the services' Kafka events: a failure is logged, and the
 * record goes again with its next change (or `cli.ts republish`).
 */
export interface BasketlineSender {
  send(tenantId: string, call: (basketline: BasketlineServer) => Promise<void>): Promise<void>
  /** Reads from Basketline with the store's API key, e.g. a campaign's results; unlike send, a failure throws (503). */
  read<T>(tenantId: string, call: (basketline: BasketlineServer) => Promise<T>): Promise<T>
}

export function createBasketlineSender({
  apiUrl,
  apiKeyFor,
  logger,
}: {
  apiUrl: string
  apiKeyFor: (tenantId: string) => Promise<string | null>
  logger: Logger
}): BasketlineSender {
  // One client per store: each keeps its integration token until shortly before it expires.
  const servers = new Map<string, { apiKey: string; server: BasketlineServer }>()

  /** The store's client, or null if it isn't connected. */
  async function serverFor(tenantId: string): Promise<BasketlineServer | null> {
    const apiKey = await apiKeyFor(tenantId)
    if (!apiKey) return null
    let cached = servers.get(tenantId)
    if (cached?.apiKey !== apiKey) {
      cached = { apiKey, server: createStoreApi({ apiUrl, tenantId, apiKey }) }
      servers.set(tenantId, cached)
    }
    return cached.server
  }

  return {
    async send(tenantId, call) {
      try {
        const server = await serverFor(tenantId)
        if (!server) {
          logger.warn({ tenantId }, 'store not connected to Basketline; its records are not sent')
          return
        }
        await call(server)
      } catch (error) {
        logger.error({ err: error, tenantId }, 'failed to send records to Basketline; they go again with the next change')
      }
    },

    async read(tenantId, call) {
      const server = await serverFor(tenantId)
      if (!server) throw serviceUnavailable('BASKETLINE_NOT_CONNECTED', 'This store is not connected to Basketline')
      try {
        return await call(server)
      } catch (error) {
        logger.error({ err: error, tenantId }, 'Basketline read failed')
        throw serviceUnavailable('BASKETLINE_UNAVAILABLE', 'Basketline could not answer; try again shortly')
      }
    },
  }
}

