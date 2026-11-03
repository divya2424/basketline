import type { Logger } from '@basketline/platform'
import type { ClickHouse } from '@basketline/platform/clickhouse'
import { activeCampaignIds } from '../repositories/campaign.repository.ts'

/** Whether a campaign is one of the tenant's active ones: only those get impressions and clicks counted. */
export interface CampaignDirectory {
  isActive(tenantId: string, campaignId: string): Promise<boolean>
}

/** Every campaign counts: for tests that aren't about the check, and setups without the campaign topic. */
export const ANY_CAMPAIGN: CampaignDirectory = { isActive: async () => true }

/**
 * The tenants' active campaigns from ClickHouse, each tenant's set kept for
 * `ttlMs`. A campaign not in the set reloads it first (at most every `missMs`),
 * so one created a moment ago counts as soon as ClickHouse has it (about a
 * second after the retail API). If ClickHouse can't answer, events are accepted
 * and the failure logged: the check never stops ingestion.
 */
export function createCampaignDirectory({ clickhouse, logger, ttlMs = 30_000, missMs = 1_000 }: { clickhouse: ClickHouse; logger: Logger; ttlMs?: number; missMs?: number }): CampaignDirectory {
  const tenants = new Map<string, { ids: Promise<Set<string>>; loadedAt: number }>()

  function load(tenantId: string, now: number) {
    const entry = { ids: activeCampaignIds(clickhouse, tenantId), loadedAt: now }
    entry.ids.catch(() => tenants.get(tenantId) === entry && tenants.delete(tenantId))
    tenants.set(tenantId, entry)
    return entry.ids
  }

  return {
    async isActive(tenantId, campaignId) {
      const now = Date.now()
      try {
        let entry = tenants.get(tenantId)
        if (!entry || now - entry.loadedAt > ttlMs) return (await load(tenantId, now)).has(campaignId)
        if ((await entry.ids).has(campaignId)) return true
        entry = tenants.get(tenantId)
        return now - entry!.loadedAt > missMs ? (await load(tenantId, now)).has(campaignId) : false
      } catch (error) {
        logger.warn({ err: error, tenantId }, "can't read the tenant's campaigns; the event is accepted unchecked")
        return true
      }
    },
  }
}
