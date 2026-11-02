/**
 * Operator CLI. Sends every campaign's current state to Basketline's reference
 * API (platform retailer.ts), e.g. for campaigns from before the integration.
 * Campaigns from before sellers first get the seller of their products; run
 * product-service's `cli.ts republish` before this, so the products copy has
 * them. A campaign whose products have no seller or several stays unsent.
 *
 *   node src/cli.ts republish
 */
import { parseArgs } from 'node:util'
import { closeDb, createLogger, requireEnv, retailerIntegrationFromEnv } from '@basketline/platform'
import { createCampaignDb, migrateCampaignDb } from './db/client.ts'
import { fillCampaignSellers, listAllCampaigns } from './repositories/campaign.repository.ts'
import { campaignUpdate } from './services/campaign.service.ts'

const BATCH = 500

const { positionals } = parseArgs({ allowPositionals: true })
if (positionals[0] !== 'republish') throw new Error('Usage: cli.ts republish')

const logger = createLogger('campaign-cli')
const retailer = retailerIntegrationFromEnv(logger)
if (!retailer) throw new Error('Set BASKETLINE_API_URL, AUTH_INTERNAL_URL and INTERNAL_INTEGRATION_SECRET')
const db = createCampaignDb(requireEnv('DATABASE_URL'), logger)
try {
  await migrateCampaignDb(db)
  const sellersFilled = await fillCampaignSellers(db)
  const campaigns = await listAllCampaigns(db)
  let sent = 0
  for (const tenantId of new Set(campaigns.map((campaign) => campaign.tenantId))) {
    const updates = campaigns.filter((campaign) => campaign.tenantId === tenantId).flatMap((campaign) => campaignUpdate(campaign) ?? [])
    for (let i = 0; i < updates.length; i += BATCH) await retailer.send(tenantId, 'campaigns', updates.slice(i, i + BATCH))
    sent += updates.length
  }
  console.log(JSON.stringify({ sellersFilled, sent, withoutSeller: campaigns.length - sent }))
} finally {
  await closeDb(db)
}
