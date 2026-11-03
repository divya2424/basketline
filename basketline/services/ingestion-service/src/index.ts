import { CAMPAIGN_PRODUCTS_TOPIC, CAMPAIGN_TOPIC, CATALOG_TOPIC, IDENTITY_TOPIC, INTERACTIONS_TOPIC, SERVING_TOPICS, TOPICS } from '@basketline/contracts'
import { createBusFromEnv, createHealth, createLogger, handleShutdown, intEnv, requireEnv } from '@basketline/platform'
import { createClickHouse } from '@basketline/platform/clickhouse'
import { buildIngestionApp } from './app.ts'
import { createCampaignDirectory } from './services/campaign.directory.ts'
import { handleIdentityEvent } from './events/identity.consumer.ts'
import { handleTenantEvent } from './events/tenant.consumer.ts'
import { TENANT_EVENTS_PER_MINUTE } from './services/ingestion.service.ts'

const logger = createLogger('ingestion-service')
const health = createHealth()

// The interactions topic keeps 14 days: the Flink job keeps clicks 13 days (7-day
// attribution window + late arrivals + slack), so a replay from the topics can rebuild
// all of it. Applies when a topic is created; see
// basketline/README.md for changing existing ones.
const ANALYTICS_RETENTION_MS = String(14 * 24 * 60 * 60 * 1000)
// The serving topics only bridge Flink and ClickHouse, so they keep 48 hours, enough
// to ride out a ClickHouse outage; replays come from the interactions topic.
const SERVING_RETENTION_MS = String(48 * 60 * 60 * 1000)
// Reference data (sellers, products, campaigns, campaign products): the latest state per
// ID is kept for good (compacted); the data lake (basketline/connect) keeps every update.
const REFERENCE_CONFIGS = { 'cleanup.policy': 'compact' }

// Creates the topics this service publishes to (interactions, identity, reference
// data) and the serving topics the Flink job writes for ClickHouse.
const bus = await createBusFromEnv('ingestion-service', logger, [
  { name: INTERACTIONS_TOPIC, configs: { 'retention.ms': ANALYTICS_RETENTION_MS } },
  { name: IDENTITY_TOPIC, configs: { 'retention.ms': ANALYTICS_RETENTION_MS } },
  { name: CATALOG_TOPIC, configs: REFERENCE_CONFIGS },
  { name: CAMPAIGN_TOPIC, configs: REFERENCE_CONFIGS },
  { name: CAMPAIGN_PRODUCTS_TOPIC, configs: REFERENCE_CONFIGS },
  ...Object.values(SERVING_TOPICS).map((name) => ({ name, configs: { 'retention.ms': SERVING_RETENTION_MS } })),
])
health.addCheck('kafka', () => bus.healthCheck())

const clickhouse = createClickHouse(requireEnv('CLICKHOUSE_URL'))
// Deletions only: erasures (user_deleted) and deleted tenants. Applying one twice is harmless.
await bus.subscribe({
  groupId: 'ingestion-service',
  topics: [IDENTITY_TOPIC, TOPICS.tenants],
  handler: async (envelope, { topic }) => (topic.endsWith(IDENTITY_TOPIC) ? handleIdentityEvent(clickhouse, envelope) : handleTenantEvent(clickhouse, envelope)),
})

// Each tenant's ingestion budget per instance, by tier (ingestion.service.ts).
const tenantEventsPerMinute = {
  free: intEnv('TENANT_EVENTS_PER_MINUTE_FREE', TENANT_EVENTS_PER_MINUTE.free!),
  pro: intEnv('TENANT_EVENTS_PER_MINUTE_PRO', TENANT_EVENTS_PER_MINUTE.pro!),
  enterprise: intEnv('TENANT_EVENTS_PER_MINUTE_ENTERPRISE', TENANT_EVENTS_PER_MINUTE.enterprise!),
}
const campaigns = createCampaignDirectory({ clickhouse, logger })
const app = buildIngestionApp({ bus, clickhouse, logger, health, campaigns, tenantEventsPerMinute })
const port = intEnv('PORT', 4004)
const server = app.listen(port, () => {
  health.markStarted()
  logger.info({ port }, 'ingestion-service listening')
})

handleShutdown({
  logger,
  server,
  health,
  closers: [
    { name: 'kafka', close: () => bus.close() },
    { name: 'clickhouse', close: () => clickhouse.close() },
  ],
})
