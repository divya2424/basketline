import type { EventEnvelope, EventPayloads } from '@shopsphere/contracts'
import type { ClickHouse } from '../clickhouse.ts'
import { upsertCampaignState } from '../repositories/campaign.repository.ts'

/** Applies campaign.v1 events to the campaign projection that event ingestion checks. */
export async function handleCampaignEvent(clickhouse: ClickHouse, envelope: EventEnvelope): Promise<void> {
  switch (envelope.eventType) {
    case 'CampaignCreated':
    case 'CampaignUpdated': {
      const campaign = envelope.payload as EventPayloads['CampaignCreated']
      // Events from before campaigns had tenants: the campaign's next update counts.
      if (!campaign.tenantId) return
      await upsertCampaignState(clickhouse, campaign, envelope.aggregateVersion)
      return
    }
    default:
      // Product associations don't change whether a campaign can be counted.
      return
  }
}
