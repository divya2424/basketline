import { randomUUID } from 'node:crypto'
import { ANALYTICS_EVENT_NAMES, analyticsTopic, SERVING_TOPICS, TOPICS, WATERMARK_HEARTBEAT_TOPIC } from '@basketline/contracts'
import { createBusFromEnv, createHealth, createLogger, handleShutdown, intEnv, loadPublicKey, requireEnv, secretEnv } from '@basketline/platform'
import { buildAnalyticsApp } from './app.ts'
import { createClickHouse } from './clickhouse.ts'
import { handleCampaignEvent } from './events/campaign.consumer.ts'
import { handleTenantEvent } from './events/tenant.consumer.ts'

const logger = createLogger('analytics-service')
const health = createHealth()

// The analytics topics keep 14 days: the Flink job keeps clicks 13 days (7-day
// attribution window + 5 days events may arrive late + a day of slack), so a replay from the
// topics can rebuild all of it. Applies when a topic is created; see
// backend/README.md for changing existing ones.
const ANALYTICS_RETENTION_MS = String(14 * 24 * 60 * 60 * 1000)
// The serving topics only bridge Flink and ClickHouse, so they keep 48 hours, enough
// to ride out a ClickHouse outage; replays come from the analytics topics.
const SERVING_RETENTION_MS = String(48 * 60 * 60 * 1000)
// A heartbeat is only useful while it is the newest time Flink has seen.
const HEARTBEAT_RETENTION_MS = String(60 * 60 * 1000)

// Creates the analytics.<eventName>.v1 topics this service publishes to, the
// heartbeat topic, and the serving topics the Flink job writes for ClickHouse.
const bus = await createBusFromEnv('analytics-service', logger, [
  ...ANALYTICS_EVENT_NAMES.map((eventName) => ({ name: analyticsTopic(eventName), configs: { 'retention.ms': ANALYTICS_RETENTION_MS } })),
  { name: WATERMARK_HEARTBEAT_TOPIC, configs: { 'retention.ms': HEARTBEAT_RETENTION_MS } },
  ...Object.values(SERVING_TOPICS).map((name) => ({ name, configs: { 'retention.ms': SERVING_RETENTION_MS } })),
])
health.addCheck('kafka', () => bus.healthCheck())

// Every 30 s, half the Flink source's idle timeout, so the heartbeat's partition never
// counts as idle. One key, so every instance's heartbeats share one partition.
const heartbeat = setInterval(() => {
  const timestamp = new Date().toISOString()
  const envelope = { eventId: randomUUID(), eventType: 'WatermarkHeartbeat', eventVersion: 1, occurredAt: timestamp, producer: 'analytics-service', aggregateId: 'heartbeat', aggregateVersion: 1, payload: { timestamp } }
  bus.publish([{ topic: WATERMARK_HEARTBEAT_TOPIC, key: 'heartbeat', envelope }]).catch((error) => logger.warn({ err: error }, 'watermark heartbeat failed'))
}, 30_000)
const clickhouse = createClickHouse(requireEnv('CLICKHOUSE_URL'))
// Campaign status for checking metric events, and deleted tenants (whose analytics are
// deleted). Applying an event twice is harmless.
await bus.subscribe({
  groupId: 'analytics-service',
  topics: [TOPICS.campaigns, TOPICS.tenants],
  handler: async (envelope) => {
    await handleCampaignEvent(clickhouse, envelope)
    await handleTenantEvent(clickhouse, envelope)
  },
})

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
    { name: 'watermark heartbeat timer', close: () => clearInterval(heartbeat) },
    { name: 'kafka', close: () => bus.close() },
    { name: 'clickhouse', close: () => clickhouse.close() },
  ],
})
