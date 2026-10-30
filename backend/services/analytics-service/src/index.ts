import { ANALYTICS_EVENT_NAMES, analyticsTopic, SERVING_TOPICS, TOPICS } from '@basketline/contracts'
import { createBusFromEnv, createHealth, createLogger, handleShutdown, intEnv, loadPublicKey, requireEnv, secretEnv } from '@basketline/platform'
import { buildAnalyticsApp } from './app.ts'
import { createClickHouse } from './clickhouse.ts'
import { handleCampaignEvent } from './events/campaign.consumer.ts'

const logger = createLogger('analytics-service')
const health = createHealth()

// The analytics topics keep 14 days: the Flink job keeps clicks 12 days (7-day
// attribution window + 5 days events may arrive late), so a replay from the
// topics can rebuild all of it. Applies when a topic is created; see
// backend/README.md for changing existing ones.
const ANALYTICS_RETENTION_MS = String(14 * 24 * 60 * 60 * 1000)
// The serving topics only bridge Flink and ClickHouse, so they keep 48 hours, enough
// to ride out a ClickHouse outage; replays come from the analytics topics.
const SERVING_RETENTION_MS = String(48 * 60 * 60 * 1000)

// Creates the analytics.<eventName>.v1 topics this service publishes to, and the
// serving topics the Flink job writes for ClickHouse.
const bus = await createBusFromEnv('analytics-service', logger, [
  ...ANALYTICS_EVENT_NAMES.map((eventName) => ({ name: analyticsTopic(eventName), configs: { 'retention.ms': ANALYTICS_RETENTION_MS } })),
  ...Object.values(SERVING_TOPICS).map((name) => ({ name, configs: { 'retention.ms': SERVING_RETENTION_MS } })),
])
health.addCheck('kafka', () => bus.healthCheck())
const clickhouse = createClickHouse(requireEnv('CLICKHOUSE_URL'))
// Campaign status for checking metric events. Applying an event twice is harmless (see campaign.repository.ts).
await bus.subscribe({ groupId: 'analytics-service', topics: [TOPICS.campaigns], handler: (envelope) => handleCampaignEvent(clickhouse, envelope) })

// Dashboards refresh every 20 s; reusing a count for 15 s keeps their cost flat as viewers grow.
const metricsCacheMs = intEnv('METRICS_CACHE_MS', 15_000)
const app = buildAnalyticsApp({ bus, clickhouse, logger, health, metricsCacheMs, publicKey: await loadPublicKey(secretEnv('JWT_PUBLIC_KEY')) })
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
