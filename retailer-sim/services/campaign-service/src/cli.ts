/**
 * Operator CLI. Sends every campaign's current state to Basketline with its
 * store's API key, e.g. after Basketline lost them. Campaigns from before sellers
 * first get the seller of their products; run product-service's `cli.ts
 * republish` before this, so the products copy has them. A campaign whose
 * products have no seller or several stays unsent.
 *
 *   node src/cli.ts republish
 */
import { parseArgs } from 'node:util'
import { closeDb, createLogger, requireEnv, secretEnv } from '@basketline/platform'
import { createBasketlineSender, openSecret } from '@retailer-sim/shared'
import { createCampaignDb, migrateCampaignDb } from './db/client.ts'
import { fillCampaignSellers, listAllCampaigns } from './repositories/campaign.repository.ts'
import { findSealedApiKey } from './repositories/store.repository.ts'
import { basketlineCampaign } from './services/campaign.service.ts'

const BATCH = 500

const { positionals } = parseArgs({ allowPositionals: true })
if (positionals[0] !== 'republish') throw new Error('Usage: cli.ts republish')

const logger = createLogger('campaign-cli')
const db = createCampaignDb(requireEnv('DATABASE_URL'), logger)
try {
  await migrateCampaignDb(db)
  const secretsKey = secretEnv('RETAILER_SECRETS_KEY')
  const basketline = createBasketlineSender({
    apiUrl: requireEnv('BASKETLINE_API_URL'),
    apiKeyFor: async (tenantId) => {
      const sealed = await findSealedApiKey(db, tenantId)
      return sealed ? openSecret(sealed, secretsKey) : null
    },
    logger,
  })
  const sellersFilled = await fillCampaignSellers(db)
  const campaigns = await listAllCampaigns(db)
  let sent = 0
  for (const tenantId of new Set(campaigns.map((campaign) => campaign.tenantId))) {
    const updates = campaigns.filter((campaign) => campaign.tenantId === tenantId).flatMap((campaign) => basketlineCampaign(campaign) ?? [])
    // The retail API takes up to 500 updates a request.
    await basketline.send(tenantId, async (server) => {
      for (let i = 0; i < updates.length; i += BATCH) await server.campaigns.upsert(updates.slice(i, i + BATCH))
    })
    sent += updates.length
  }
  console.log(JSON.stringify({ sellersFilled, sent, withoutSeller: campaigns.length - sent }))
} finally {
  await closeDb(db)
}
