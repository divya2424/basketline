/**
 * The mimic retailer's side of the Basketline integration. product-service and
 * campaign-service act as every tenant's backend: after each change they send the
 * record's full state to Basketline's reference API (POST /api/v1/retail/catalog and
 * /api/v1/retail/campaigns), as a real retailer's backend does with the server SDK and its
 * API key. Being every tenant at once, they get integration tokens from
 * auth-service's internal endpoint (a secret shared in the cluster) instead of an
 * API key per tenant.
 *
 * Best effort, like their Kafka events: a failure is logged, and the record goes
 * again with its next change.
 */
import type { Logger } from './logger.ts'

export interface ReferenceUpdate {
  eventName: string
  updatedAt: string
  data: Record<string, unknown>
}

export interface RetailerIntegration {
  send(tenantId: string, endpoint: 'catalog' | 'campaigns', updates: ReferenceUpdate[]): Promise<void>
}

export function createRetailerIntegration({ apiUrl, authUrl, secret, logger }: { apiUrl: string; authUrl: string; secret: string; logger: Logger }): RetailerIntegration {
  // Integration tokens last 15 minutes; one is reused for 12.
  const tokens = new Map<string, { token: string; until: number }>()

  async function tokenFor(tenantId: string): Promise<string> {
    const cached = tokens.get(tenantId)
    if (cached && cached.until > Date.now()) return cached.token
    const res = await fetch(`${authUrl.replace(/\/$/, '')}/internal/integration-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify({ tenantId }),
    })
    if (!res.ok) throw new Error(`integration token: ${res.status} ${await res.text()}`)
    const { integrationToken } = (await res.json()) as { integrationToken: string }
    tokens.set(tenantId, { token: integrationToken, until: Date.now() + 12 * 60_000 })
    return integrationToken
  }

  return {
    async send(tenantId, endpoint, updates) {
      if (updates.length === 0) return
      try {
        const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v1/retail/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${await tokenFor(tenantId)}` },
          body: JSON.stringify({ events: updates }),
        })
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      } catch (error) {
        logger.error({ err: error, tenantId, endpoint, count: updates.length }, 'failed to send reference data to Basketline; it goes again with the next change')
      }
    },
  }
}

/** From BASKETLINE_API_URL, AUTH_INTERNAL_URL and INTERNAL_INTEGRATION_SECRET; undefined when any is unset (nothing is sent). */
export function retailerIntegrationFromEnv(logger: Logger): RetailerIntegration | undefined {
  const { BASKETLINE_API_URL: apiUrl, AUTH_INTERNAL_URL: authUrl, INTERNAL_INTEGRATION_SECRET: secret } = process.env
  return apiUrl && authUrl && secret ? createRetailerIntegration({ apiUrl, authUrl, secret, logger }) : undefined
}
