import { randomUUID } from 'node:crypto'
import type { CryptoKey } from 'jose'
import { signRetailerToken, type RetailerRole } from './auth.ts'
import type { BasketlineSender, BasketlineServer, CampaignMetric, CampaignProductResult } from './basketline.ts'

/** A retailer token, as retailer-auth-service signs one; a seller's acts for `sel` (default a random seller). */
export async function retailerTokenFor(
  privateKey: CryptoKey,
  role: RetailerRole,
  { tid = randomUUID(), sub = randomUUID(), sel = role === 'seller' ? randomUUID() : undefined }: { tid?: string; sub?: string; sel?: string } = {},
) {
  const { token } = await signRetailerToken(privateKey, { userId: sub, tenantId: tid, role, sellerId: sel })
  return { token, sub, tid, sel, header: `Bearer ${token}` }
}

export interface SentToBasketline {
  tenantId: string
  /** The SDK call, e.g. "catalog.upsertProduct". */
  call: string
  records: Record<string, unknown>[]
}

/**
 * A BasketlineSender that records each call instead of sending it; campaigns'
 * results per product are `results`, and their metrics `metrics` by name (tests fill them; 0 otherwise).
 */
export function createFakeBasketline(): { basketline: BasketlineSender; sent: SentToBasketline[]; results: CampaignProductResult[]; metrics: Record<string, CampaignMetric> } {
  const sent: SentToBasketline[] = []
  const results: CampaignProductResult[] = []
  const metrics: Record<string, CampaignMetric> = {}
  const record = (tenantId: string, call: string) => async (records: unknown) => void sent.push({ tenantId, call, records: [records].flat() as Record<string, unknown>[] })
  const serverFor = (tenantId: string) =>
    ({
      catalog: { upsertSeller: record(tenantId, 'catalog.upsertSeller'), upsertProduct: record(tenantId, 'catalog.upsertProduct'), removeProduct: record(tenantId, 'catalog.removeProduct') },
      campaigns: {
        upsert: record(tenantId, 'campaigns.upsert'),
        remove: record(tenantId, 'campaigns.remove'),
        addProducts: record(tenantId, 'campaigns.addProducts'),
        removeProducts: record(tenantId, 'campaigns.removeProducts'),
      },
      identity: { identified: record(tenantId, 'identity.identified'), deleteUser: record(tenantId, 'identity.deleteUser') },
      insights: {
        campaignProducts: async (query: object) => {
          sent.push({ tenantId, call: 'insights.campaignProducts', records: [query as Record<string, unknown>] })
          return results
        },
        campaignMetric: async ({ metric }: { metric: string }) => metrics[metric] ?? { count: 0 },
      },
    }) as BasketlineServer
  return { basketline: { send: (tenantId, call) => call(serverFor(tenantId)), read: (tenantId, call) => call(serverFor(tenantId)) }, sent, results, metrics }
}
