import { randomUUID } from 'node:crypto'
import type { CryptoKey } from 'jose'
import { signRetailerToken, type RetailerRole } from './auth.ts'
import type { BasketlineSender, BasketlineServer } from './basketline.ts'

/** A retailer token, as retailer-auth-service signs one. */
export async function retailerTokenFor(privateKey: CryptoKey, role: RetailerRole, { tid = randomUUID(), sub = randomUUID() }: { tid?: string; sub?: string } = {}) {
  const { token } = await signRetailerToken(privateKey, { userId: sub, tenantId: tid, role })
  return { token, sub, tid, header: `Bearer ${token}` }
}

export interface SentToBasketline {
  tenantId: string
  /** The SDK call, e.g. "catalog.upsertProduct". */
  call: string
  records: Record<string, unknown>[]
}

/** A BasketlineSender that records each SDK call instead of sending it. */
export function createFakeBasketline(): { basketline: BasketlineSender; sent: SentToBasketline[] } {
  const sent: SentToBasketline[] = []
  const record = (tenantId: string, call: string) => async (records: unknown) => void sent.push({ tenantId, call, records: [records].flat() as Record<string, unknown>[] })
  const serverFor = (tenantId: string) =>
    ({
      catalog: { upsertSeller: record(tenantId, 'catalog.upsertSeller'), upsertProduct: record(tenantId, 'catalog.upsertProduct'), removeProduct: record(tenantId, 'catalog.removeProduct') },
      campaigns: { upsert: record(tenantId, 'campaigns.upsert'), remove: record(tenantId, 'campaigns.remove') },
      identity: { identified: record(tenantId, 'identity.identified'), deleteUser: record(tenantId, 'identity.deleteUser') },
    }) as BasketlineServer
  return { basketline: { send: (tenantId, call) => call(serverFor(tenantId)) }, sent }
}
