import { ANALYTICS_EVENT_NAMES, analyticsTopic, TOPICS } from '@ecommerce-analytics/contracts'
import { createBusFromEnv, createHealth, createLogger, handleShutdown, intEnv, loadPublicKey, requireEnv, secretEnv } from '@ecommerce-analytics/platform'
import { buildAnalyticsApp } from './app.ts'
import { createClickHouse } from './clickhouse.ts'
import { handleCampaignEvent } from './events/campaign.consumer.ts'

const logger = createLogger('analytics-service')
const health = createHealth()

// Creates the analytics.<eventName>.v1 topics this service publishes to.
const bus = await createBusFromEnv('analytics-service', logger, ANALYTICS_EVENT_NAMES.map(analyticsTopic))
health.addCheck('kafka', () => bus.healthCheck())
const clickhouse = createClickHouse(requireEnv('CLICKHOUSE_URL'))
// Campaign status for checking metric events. Applying an event twice is harmless (see campaign.repository.ts).
await bus.subscribe({ groupId: 'analytics-service', topics: [TOPICS.campaigns], handler: (envelope) => handleCampaignEvent(clickhouse, envelope) })

const app = buildAnalyticsApp({ bus, clickhouse, logger, health, publicKey: await loadPublicKey(secretEnv('JWT_PUBLIC_KEY')) })
const port = intEnv('PORT', 4004)
const server = app.listen(port, () => {
  health.markStarted()
  logger.info({ port }, 'analytics-service listening')
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
